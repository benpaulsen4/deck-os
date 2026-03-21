import test from "node:test";
import assert from "node:assert/strict";
import {
  FilesAccessDeniedError,
  FilesAlreadyExistsError,
  FilesNotDirectoryError,
  FilesNotFileError,
  FilesNotFoundError,
} from "../services/files.js";
import { mapFilesError } from "./filesErrors.js";

test("mapFilesError maps files domain errors consistently", () => {
  assert.deepEqual(mapFilesError(new FilesAccessDeniedError("/secret"), "fallback"), {
    status: 403,
    trpcCode: "FORBIDDEN",
    message: "Access denied for protected path: /secret",
  });
  assert.deepEqual(mapFilesError(new FilesNotFoundError("/missing"), "fallback"), {
    status: 404,
    trpcCode: "NOT_FOUND",
    message: "Path not found: /missing",
  });
  assert.deepEqual(mapFilesError(new FilesNotDirectoryError("/file"), "fallback"), {
    status: 400,
    trpcCode: "BAD_REQUEST",
    message: "Path is not a directory: /file",
  });
  assert.deepEqual(mapFilesError(new FilesNotFileError("/dir"), "fallback"), {
    status: 400,
    trpcCode: "BAD_REQUEST",
    message: "Path is not a file: /dir",
  });
  assert.deepEqual(mapFilesError(new FilesAlreadyExistsError("/exists"), "fallback"), {
    status: 409,
    trpcCode: "CONFLICT",
    message: "Path already exists: /exists",
  });
});

test("mapFilesError maps eexist into conflict", () => {
  const err = new Error("boom") as NodeJS.ErrnoException;
  err.code = "EEXIST";
  assert.deepEqual(mapFilesError(err, "fallback"), {
    status: 409,
    trpcCode: "CONFLICT",
    message: "One or more files already exist",
  });
});
