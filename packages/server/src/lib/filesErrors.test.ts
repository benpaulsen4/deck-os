import { test, expect } from "vitest";
import {
  FilesAccessDeniedError,
  FilesAlreadyExistsError,
  FilesNotDirectoryError,
  FilesNotFileError,
  FilesNotFoundError,
} from "../services/files.js";
import { mapFilesError } from "./filesErrors.js";

test("mapFilesError maps files domain errors consistently", () => {
  expect(mapFilesError(new FilesAccessDeniedError("/secret"), "fallback")).toEqual({
    status: 403,
    trpcCode: "FORBIDDEN",
    message: "Access denied for protected path: /secret",
  });
  expect(mapFilesError(new FilesNotFoundError("/missing"), "fallback")).toEqual({
    status: 404,
    trpcCode: "NOT_FOUND",
    message: "Path not found: /missing",
  });
  expect(mapFilesError(new FilesNotDirectoryError("/file"), "fallback")).toEqual({
    status: 400,
    trpcCode: "BAD_REQUEST",
    message: "Path is not a directory: /file",
  });
  expect(mapFilesError(new FilesNotFileError("/dir"), "fallback")).toEqual({
    status: 400,
    trpcCode: "BAD_REQUEST",
    message: "Path is not a file: /dir",
  });
  expect(mapFilesError(new FilesAlreadyExistsError("/exists"), "fallback")).toEqual({
    status: 409,
    trpcCode: "CONFLICT",
    message: "Path already exists: /exists",
  });
});

test("mapFilesError maps eexist into conflict", () => {
  const err = new Error("boom") as NodeJS.ErrnoException;
  err.code = "EEXIST";
  expect(mapFilesError(err, "fallback")).toEqual({
    status: 409,
    trpcCode: "CONFLICT",
    message: "One or more files already exist",
  });
});

test("mapFilesError maps oversized payload and unknown errors to fallback messages", () => {
  const largeFile = new Error("filesystem payload too large") as NodeJS.ErrnoException;
  largeFile.code = "EFBIG";
  expect(mapFilesError(largeFile, "Upload failed")).toEqual({
    status: 413,
    trpcCode: "PAYLOAD_TOO_LARGE",
    message: "Upload failed",
  });

  expect(mapFilesError(new Error("raw internal"), "Files operation failed")).toEqual({
    status: 500,
    trpcCode: "INTERNAL_SERVER_ERROR",
    message: "Files operation failed",
  });
});
