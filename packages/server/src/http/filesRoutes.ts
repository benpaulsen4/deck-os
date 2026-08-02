import type { Hono } from "hono";
import { basename, join } from "path";
import { createReadStream } from "fs";
import { open, readFile, stat, unlink } from "node:fs/promises";
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
const MAX_UPLOAD_FIELDS = 8;
const MAX_UPLOAD_FIELD_BYTES = 64 * 1024;
const MAX_UPLOAD_FIELD_NAME_BYTES = 200;
const UPLOAD_FILE_FIELD = "files";

/**
 * Builds a Content-Disposition value that survives non-Latin-1 names. `Headers.set`
 * throws on code points above 255, so the name is emitted twice: a sanitized ASCII
 * `filename` for old clients and an RFC 5987 `filename*` with the real name (FILE-7).
 */
function toAttachmentDisposition(fileName: string): string {
  const asciiFallback = fileName
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .trim();
  const safeFallback = asciiFallback.length > 0 ? asciiFallback : "download";
  // encodeURIComponent leaves !'()* alone but RFC 5987 attr-char excludes '()*.
  const encodedName = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${safeFallback}"; filename*=UTF-8''${encodedName}`;
}

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
        // Busboy defaults every limit to Infinity, so without these a part under an
        // unexpected field name was drained with no cap at all (FILE-9).
        limits: {
          files: MAX_UPLOAD_FILES,
          fileSize: MAX_UPLOAD_FILE_BYTES,
          parts: MAX_UPLOAD_FILES + MAX_UPLOAD_FIELDS,
          fields: MAX_UPLOAD_FIELDS,
          fieldSize: MAX_UPLOAD_FIELD_BYTES,
          fieldNameSize: MAX_UPLOAD_FIELD_NAME_BYTES,
        },
      });
      const uploadedByIndex: Array<string | undefined> = [];
      const activeFileStreams = new Set<Readable>();
      // The reject handler below is a `once`, so once the parse promise has settled the
      // request stream would have no error listener left; a later teardown would then
      // rethrow instead of unwinding quietly.
      requestStream.on("error", () => undefined);
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
        const cause =
          error instanceof Error
            ? error
            : new Error(typeof error === "string" ? error : "Upload failed");
        // Tear down the in-flight part streams as well as the request: with only the
        // request destroyed, busboy never ends those parts and the pipelines awaited
        // below would hang forever.
        for (const activeStream of activeFileStreams) {
          activeStream.destroy(cause);
        }
        parser.destroy(cause);
        requestStream.destroy(cause);
      };

      parser.on("file", (fieldName, stream, info) => {
        activeFileStreams.add(stream);
        // Destroying a stream nobody listens to makes EventEmitter rethrow the error
        // synchronously, inside busboy's own write loop. The reason is already recorded
        // in uploadError, so a part stream's error only needs to be absorbed here.
        stream.on("error", () => undefined);
        if (fieldName !== UPLOAD_FILE_FIELD) {
          // Abort rather than drain an unbounded body under an unknown field name.
          setUploadError(
            new UploadRequestError(400, `Unexpected upload field: ${fieldName}`)
          );
          return;
        }

        hasFile = true;
        filesCount += 1;
        if (filesCount > MAX_UPLOAD_FILES) {
          setUploadError(
            new UploadRequestError(400, `Too many files. Maximum is ${MAX_UPLOAD_FILES}.`)
          );
          return;
        }

        const safeName = basename(info.filename ?? "");
        if (!isSafeUploadName(info.filename ?? "") || !safeName) {
          setUploadError(
            new UploadRequestError(400, `Invalid file name: ${info.filename}`)
          );
          return;
        }
        stream.on("limit", () => {
          setUploadError(new UploadRequestError(413, `File too large: ${safeName}`));
        });
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

          // "wx" refuses to clobber, so an EEXIST here means the collided file belongs
          // to someone else and must not be unlinked in the failure path (FILE-2).
          const handle = await open(targetPath, "wx");
          try {
            await pipeline(stream, limiter, handle.createWriteStream());
            uploadedByIndex[uploadIndex] = safeName;
          } catch (error) {
            await unlink(targetPath).catch(() => undefined);
            throw error;
          } finally {
            await handle.close().catch(() => undefined);
          }
        })().finally(() => {
          activeFileStreams.delete(stream);
        });

        fileTasks.push(task);
        task.catch((error) => {
          setUploadError(error);
        });
      });

      parser.on("filesLimit", () => {
        setUploadError(
          new UploadRequestError(400, `Too many files. Maximum is ${MAX_UPLOAD_FILES}.`)
        );
      });
      parser.on("fieldsLimit", () => {
        setUploadError(new UploadRequestError(400, "Too many form fields"));
      });
      parser.on("partsLimit", () => {
        setUploadError(new UploadRequestError(400, "Too many multipart parts"));
      });
      parser.on("error", (error) => {
        // Busboy only errors on input it cannot parse (a malformed part header, a
        // truncated body), which is a client problem rather than a server fault.
        setUploadError(
          error instanceof UploadRequestError
            ? error
            : new UploadRequestError(400, "Malformed multipart request")
        );
      });

      let parseError: unknown = null;
      try {
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
      } catch (error) {
        parseError = error;
      }

      // Always settle every write before responding: the previous `Promise.all` was
      // skipped entirely when the parse promise rejected, so the response raced tasks
      // that were still writing to disk (FILE-10).
      await Promise.allSettled(fileTasks);

      const uploaded = uploadedByIndex.filter(
        (name): name is string => typeof name === "string"
      );
      const failure = uploadError ?? parseError;
      if (failure) {
        // Report exactly which files landed; failed writes are unlinked above.
        if (failure instanceof UploadRequestError) {
          return c.json({ error: failure.message, uploaded }, failure.status);
        }
        const mappedFailure = mapFilesError(failure, "Upload failed");
        return c.json({ error: mappedFailure.message, uploaded }, mappedFailure.status);
      }
      if (!hasFile) {
        return c.json({ error: "No files uploaded" }, 400);
      }

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
      c.header("Content-Disposition", toAttachmentDisposition(basename(filePath)));
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
