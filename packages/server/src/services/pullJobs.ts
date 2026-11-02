import * as crypto from "node:crypto";
import { readComposeImages } from "../lib/composeParser.js";
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

type PullJobListener = (snapshot: PullJobSnapshot) => void;

const jobs = new Map<string, PullJobInternal>();
const runningByAppId = new Map<string, string>();
const listenersByJobId = new Map<string, Set<PullJobListener>>();

const RUNNING_TTL_MS = 2 * 60 * 60 * 1000;
const FINISHED_TTL_MS = 5 * 60 * 1000;

function toSnapshot(job: PullJobInternal): PullJobSnapshot {
  const {
    controller: _controller,
    createdAt: _createdAt,
    finishedAt: _finishedAt,
    ...snapshot
  } = job;
  return snapshot;
}

function notifyPullJobUpdate(jobId: string) {
  const listeners = listenersByJobId.get(jobId);
  if (!listeners || listeners.size === 0) return;
  const job = jobs.get(jobId);
  if (!job) return;
  const snapshot = toSnapshot(job);
  for (const listener of listeners) {
    listener(snapshot);
  }
}

function pruneJobs(now: number = Date.now()) {
  for (const [jobId, job] of jobs) {
    if (job.status === "running") {
      if (now - job.createdAt > RUNNING_TTL_MS) {
        job.controller.abort();
        job.status = "error";
        job.error = "Pull timed out";
        job.finishedAt = now;
        notifyPullJobUpdate(jobId);
        if (runningByAppId.get(job.appId) === jobId) {
          runningByAppId.delete(job.appId);
        }
      }
      continue;
    }

    const finishedAt = job.finishedAt ?? job.createdAt;
    if (now - finishedAt > FINISHED_TTL_MS) {
      jobs.delete(jobId);
      listenersByJobId.delete(jobId);
      if (runningByAppId.get(job.appId) === jobId) {
        runningByAppId.delete(job.appId);
      }
    }
  }
}

export function getPullJob(jobId: string): PullJobSnapshot | null {
  pruneJobs();
  const job = jobs.get(jobId);
  if (!job) return null;
  return toSnapshot(job);
}

export function subscribeToPullJob(jobId: string, listener: PullJobListener): () => void {
  let listeners = listenersByJobId.get(jobId);
  if (!listeners) {
    listeners = new Set();
    listenersByJobId.set(jobId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = listenersByJobId.get(jobId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listenersByJobId.delete(jobId);
    }
  };
}

function findRunningJob(appId: string): PullJobSnapshot | null {
  const existingJobId = runningByAppId.get(appId);
  if (!existingJobId) return null;
  const existing = getPullJob(existingJobId);
  if (existing && existing.status === "running") return existing;
  runningByAppId.delete(appId);
  return null;
}

export async function startPullJob(appId: string): Promise<PullJobSnapshot> {
  pruneJobs();
  const alreadyRunning = findRunningJob(appId);
  if (alreadyRunning) return alreadyRunning;

  const app = await appsService.getApp(appId);
  if (!app) {
    throw new Error("App not found");
  }

  const images = await readComposeImages(app.composeYaml);

  // Another request for this app may have started a job during the waits above.
  const startedMeanwhile = findRunningJob(appId);
  if (startedMeanwhile) return startedMeanwhile;

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
        notifyPullJobUpdate(jobId);
      },
      controller.signal
    )
    .then(() => {
      // A job cancelled or timed out while the pull was in flight has already
      // reached a terminal state; never overwrite it with success.
      const j = jobs.get(jobId);
      if (!j || j.status !== "running") return;
      j.status = "done";
      j.finishedAt = Date.now();
      j.progress = {
        ...j.progress,
        percent: 100,
        completedImages: j.progress.totalImages,
      };
      notifyPullJobUpdate(jobId);
      if (runningByAppId.get(appId) === jobId) {
        runningByAppId.delete(appId);
      }
    })
    .catch((err: unknown) => {
      const j = jobs.get(jobId);
      if (!j || j.status !== "running") return;
      j.status = "error";
      j.finishedAt = Date.now();
      j.error = err instanceof Error ? err.message : "Pull failed";
      notifyPullJobUpdate(jobId);
      if (runningByAppId.get(appId) === jobId) {
        runningByAppId.delete(appId);
      }
    });

  return { jobId, appId, status: "running", progress: initialProgress };
}

/**
 * Marks the job as cancelled up front rather than waiting for the pull to
 * unwind: aborting only destroys the progress stream, and docker-modem reports
 * a destroyed stream as a completed pull.
 */
export function cancelPullJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.status !== "running") return false;

  job.controller.abort();
  job.status = "error";
  job.error = "Pull cancelled";
  job.finishedAt = Date.now();
  notifyPullJobUpdate(jobId);
  if (runningByAppId.get(job.appId) === jobId) {
    runningByAppId.delete(job.appId);
  }
  return true;
}
