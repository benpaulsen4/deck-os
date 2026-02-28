import * as crypto from "node:crypto";
import { parse } from "yaml";
import * as appsService from "./apps.js";
import * as dockerService from "./docker.js";

type JobStatus = "running" | "done" | "error";

export type PullJobSnapshot = {
  jobId: string;
  appId: string;
  status: JobStatus;
  progress: dockerService.PullOverallProgress;
  error?: string;
};

type PullJobInternal = PullJobSnapshot & {
  controller: AbortController;
  createdAt: number;
  finishedAt?: number;
};

const jobs = new Map<string, PullJobInternal>();
const runningByAppId = new Map<string, string>();

const RUNNING_TTL_MS = 2 * 60 * 60 * 1000;
const FINISHED_TTL_MS = 5 * 60 * 1000;

function pruneJobs(now: number = Date.now()) {
  for (const [jobId, job] of jobs) {
    if (job.status === "running") {
      if (now - job.createdAt > RUNNING_TTL_MS) {
        job.controller.abort();
        job.status = "error";
        job.error = "Pull timed out";
        job.finishedAt = now;
        if (runningByAppId.get(job.appId) === jobId) {
          runningByAppId.delete(job.appId);
        }
      }
      continue;
    }

    const finishedAt = job.finishedAt ?? job.createdAt;
    if (now - finishedAt > FINISHED_TTL_MS) {
      jobs.delete(jobId);
      if (runningByAppId.get(job.appId) === jobId) {
        runningByAppId.delete(job.appId);
      }
    }
  }
}

function getImagesFromCompose(composeYaml: string): string[] {
  const parsed: unknown = parse(composeYaml);
  if (!parsed || typeof parsed !== "object") return [];
  const services = (parsed as Record<string, unknown>).services;
  if (!services || typeof services !== "object") return [];
  return Object.values(services as Record<string, unknown>)
    .map((svc) => {
      if (!svc || typeof svc !== "object") return "";
      const image = (svc as Record<string, unknown>).image;
      return typeof image === "string" ? image : "";
    })
    .map((s: string) => s.trim())
    .filter(Boolean);
}

export function getPullJob(jobId: string): PullJobSnapshot | null {
  pruneJobs();
  const job = jobs.get(jobId);
  if (!job) return null;
  const {
    controller: _controller,
    createdAt: _createdAt,
    finishedAt: _finishedAt,
    ...snapshot
  } = job;
  return snapshot;
}

export async function startPullJob(appId: string): Promise<PullJobSnapshot> {
  pruneJobs();
  const existingJobId = runningByAppId.get(appId);
  if (existingJobId) {
    const existing = getPullJob(existingJobId);
    if (existing && existing.status === "running") return existing;
    runningByAppId.delete(appId);
  }

  const app = await appsService.getApp(appId);
  if (!app) {
    throw new Error("App not found");
  }

  const images = getImagesFromCompose(app.composeYaml);
  const controller = new AbortController();
  const jobId = crypto.randomUUID();

  const initialProgress: dockerService.PullOverallProgress = {
    currentBytes: null,
    totalBytes: null,
    percent: 0,
    completedImages: 0,
    totalImages: images.length,
    indeterminate: true,
  };

  const job: PullJobInternal = {
    jobId,
    appId,
    status: "running",
    progress: initialProgress,
    controller,
    createdAt: Date.now(),
  };

  jobs.set(jobId, job);
  runningByAppId.set(appId, jobId);

  dockerService
    .pullImagesWithProgress(
      images,
      (progress) => {
        const j = jobs.get(jobId);
        if (!j) return;
        j.progress = progress;
      },
      controller.signal
    )
    .then(() => {
      const j = jobs.get(jobId);
      if (!j) return;
      j.status = "done";
      j.finishedAt = Date.now();
      j.progress = {
        ...j.progress,
        percent: 100,
        completedImages: j.progress.totalImages,
      };
      if (runningByAppId.get(appId) === jobId) {
        runningByAppId.delete(appId);
      }
    })
    .catch((err: unknown) => {
      const j = jobs.get(jobId);
      if (!j) return;
      j.status = "error";
      j.finishedAt = Date.now();
      j.error = err instanceof Error ? err.message : "Pull failed";
      if (runningByAppId.get(appId) === jobId) {
        runningByAppId.delete(appId);
      }
    });

  return { jobId, appId, status: "running", progress: initialProgress };
}

export function cancelPullJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.controller.abort();
  return true;
}
