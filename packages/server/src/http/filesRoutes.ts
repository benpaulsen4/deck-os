import type { Hono } from "hono";
import { basename, join } from "path";
import { createReadStream, createWriteStream } from "fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import * as filesService from "../services/files.js";
import * as templatesService from "../services/templates.js";
import { mapFilesError } from "../lib/filesErrors.js";

function toWebStream(fileStream: NodeJS.ReadableStream): ReadableStream {
  return Readable.toWeb(fileStream as unknown as Readable) as ReadableStream;
}

const MAX_UPLOAD_FILES = 32;
const MAX_UPLOAD_FILE_BYTES = 128 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 512 * 1024 * 1024;

function isSafeUploadName(fileName: string): boolean {
  const safeName = basename(fileName);
  if (!safeName || safeName !== fileName) {
    return false;
  }
  if (
    safeName.includes("\0") ||
    safeName.includes("/") ||
    safeName.includes("\\") ||
    safeName === "." ||
    safeName === ".."
  ) {
    return false;
  }
  return true;
}

class UploadRequestError extends Error {
  status: 400 | 413;

  constructor(status: 400 | 413, message: string) {
    super(message);
    this.status = status;
    this.name = "UploadRequestError";
  }
}

function toNodeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

export function registerFilesRoutes(app: Hono) {
  app.get("/api/templates/assets/:templateId/*", async (c) => {
    const { templateId } = c.req.param();
    const reqPath = c.req.path;
    const prefixEncoded = `/api/templates/assets/${encodeURIComponent(templateId)}/`;
    const prefixDecoded = `/api/templates/assets/${templateId}/`;
    const rawRel = reqPath.startsWith(prefixEncoded)
      ? reqPath.slice(prefixEncoded.length)
      : reqPath.startsWith(prefixDecoded)
        ? reqPath.slice(prefixDecoded.length)
        : "";
    let assetRel = "";
    if (rawRel) {
      try {
        assetRel = decodeURIComponent(rawRel);
      } catch {
        return c.json({ error: "Invalid asset path" }, 400);
      }
    }
    if (!assetRel) return c.json({ error: "Not found" }, 404);

    const assetPath = await templatesService.getTemplateAssetPath(templateId, assetRel);
    if (!assetPath) {
      return c.json({ error: "Not found" }, 404);
    }

    const ext = assetPath.split(".").pop()?.toLowerCase();
    const contentType =
      ext === "png"
        ? "image/png"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webp"
            ? "image/webp"
            : ext === "gif"
              ? "image/gif"
              : ext === "svg"
                ? "image/svg+xml"
                : "application/octet-stream";

    const buf = await readFile(assetPath);
    c.header("Content-Type", contentType);
    return c.body(buf);
  });

  app.post("/api/files/upload", async (c) => {
    const destinationParam = c.req.query("path");
    if (!destinationParam) {
      return c.json({ error: "Missing destination path" }, 400);
    }
    try {
      const destinationPath =
        await filesService.resolveExistingDirectoryPath(destinationParam);
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.toLowerCase().includes("multipart/form-data")) {
        return c.json({ error: "Content-Type must be multipart/form-data" }, 400);
      }
      if (!c.req.raw.body) {
        return c.json({ error: "Empty request body" }, 400);
      }
      const requestStream = Readable.fromWeb(
        c.req.raw.body as unknown as ReadableStream<Uint8Array>
      );
      const parser = Busboy({
        headers: toNodeHeaders(c.req.raw.headers),
      });
      const uploadedByIndex: Array<string | undefined> = [];
      let totalBytes = 0;
      let uploadError: unknown = null;
      let filesCount = 0;
      let hasFile = false;
      const fileTasks: Promise<void>[] = [];

      const setUploadError = (error: unknown) => {
        if (uploadError) {
          return;
        }
        uploadError = error;
        requestStream.destroy(
          error instanceof Error
            ? error
            : new Error(typeof error === "string" ? error : "Upload failed")
        );
      };

      parser.on("file", (fieldName, stream, info) => {
        if (fieldName !== "files") {
          stream.resume();
          return;
        }

        hasFile = true;
        filesCount += 1;
        if (filesCount > MAX_UPLOAD_FILES) {
          setUploadError(
            new UploadRequestError(400, `Too many files. Maximum is ${MAX_UPLOAD_FILES}.`)
          );
          stream.resume();
          return;
        }

        const safeName = basename(info.filename ?? "");
        if (!isSafeUploadName(info.filename ?? "") || !safeName) {
          setUploadError(
            new UploadRequestError(400, `Invalid file name: ${info.filename}`)
          );
          stream.resume();
          return;
        }
        const uploadIndex = uploadedByIndex.length;
        uploadedByIndex.push(undefined);

        const task = (async () => {
          const targetPath = await filesService.resolveTargetPath(
            join(destinationPath, safeName)
          );
          let fileBytes = 0;
          const limiter = new Transform({
            transform(chunk, _encoding, callback) {
              const chunkSize = Buffer.isBuffer(chunk)
                ? chunk.length
                : Buffer.byteLength(chunk as string);
              fileBytes += chunkSize;
              totalBytes += chunkSize;
              if (fileBytes > MAX_UPLOAD_FILE_BYTES) {
                callback(new UploadRequestError(413, `File too large: ${safeName}`));
                return;
              }
              if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
                callback(new UploadRequestError(413, "Total upload size exceeded"));
                return;
              }
              callback(null, chunk);
            },
          });

          try {
            await pipeline(
              stream,
              limiter,
              createWriteStream(targetPath, { flags: "wx" })
            );
            uploadedByIndex[uploadIndex] = safeName;
          } catch (error) {
            await unlink(targetPath).catch(() => undefined);
            throw error;
          }
        })();

        fileTasks.push(task);
        task.catch((error) => {
          setUploadError(error);
        });
      });

      parser.on("error", (error) => {
        setUploadError(error);
      });

      await new Promise<void>((resolve, reject) => {
        parser.once("finish", () => {
          resolve();
        });
        requestStream.once("error", (error) => {
          reject(error);
        });
        parser.once("error", (error) => {
          reject(error);
        });
        requestStream.pipe(parser);
      });

      await Promise.all(fileTasks);
      if (uploadError) {
        throw uploadError;
      }
      if (!hasFile) {
        return c.json({ error: "No files uploaded" }, 400);
      }

      const uploaded = uploadedByIndex.filter((name): name is string => typeof name === "string");
      return c.json({ uploaded });
    } catch (error: unknown) {
      if (error instanceof UploadRequestError) {
        return c.json({ error: error.message }, error.status);
      }
      const mapped = mapFilesError(error, "Upload failed");
      return c.json({ error: mapped.message }, mapped.status);
    }
  });

  app.get("/api/files/download", async (c) => {
    const targetParam = c.req.query("path");
    if (!targetParam) {
      return c.json({ error: "Missing path" }, 400);
    }
    try {
      const filePath = await filesService.resolveExistingFilePath(targetParam);
      const fileStat = await stat(filePath);
      c.header("Content-Disposition", `attachment; filename="${basename(filePath)}"`);
      c.header("Content-Type", "application/octet-stream");
      c.header("Content-Length", String(fileStat.size));
      c.header("X-Content-Type-Options", "nosniff");
      return c.body(toWebStream(createReadStream(filePath)));
    } catch (error: unknown) {
      const mapped = mapFilesError(error, "Download failed");
      return c.json({ error: mapped.message }, mapped.status);
    }
  });

  app.get("/api/files/content", async (c) => {
    const targetParam = c.req.query("path");
    if (!targetParam) {
      return c.json({ error: "Missing path" }, 400);
    }
    try {
      const filePath = await filesService.resolveExistingFilePath(targetParam);
      const fileStat = await stat(filePath);

      const mimeType = filesService.getPathMimeType(filePath);
      const totalSize = fileStat.size;
      const rangeHeader = c.req.header("range");

      c.header("Accept-Ranges", "bytes");
      c.header("Content-Type", mimeType);
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");

      if (!rangeHeader) {
        c.header("Content-Length", String(totalSize));
        return c.body(toWebStream(createReadStream(filePath)));
      }

      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match) {
        c.header("Content-Range", `bytes */${totalSize}`);
        return c.body("Requested Range Not Satisfiable", 416);
      }

      const startRaw = match[1];
      const endRaw = match[2];
      let start = startRaw ? Number.parseInt(startRaw, 10) : 0;
      let end = endRaw ? Number.parseInt(endRaw, 10) : totalSize - 1;

      if (!startRaw && endRaw) {
        const suffixLength = Number.parseInt(endRaw, 10);
        start = Math.max(totalSize - suffixLength, 0);
        end = totalSize - 1;
      }

      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end < start ||
        start >= totalSize
      ) {
        c.header("Content-Range", `bytes */${totalSize}`);
        return c.body("Requested Range Not Satisfiable", 416);
      }

      end = Math.min(end, totalSize - 1);
      const chunkSize = end - start + 1;
      c.header("Content-Range", `bytes ${start}-${end}/${totalSize}`);
      c.header("Content-Length", String(chunkSize));
      return c.body(toWebStream(createReadStream(filePath, { start, end })), 206);
    } catch (error: unknown) {
      const mapped = mapFilesError(error, "Content read failed");
      return c.json({ error: mapped.message }, mapped.status);
    }
  });
}
