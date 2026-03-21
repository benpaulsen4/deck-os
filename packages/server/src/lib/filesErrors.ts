import * as filesService from "../services/files.js";

export type FilesHttpStatusCode = 400 | 403 | 404 | 409 | 413 | 500;
export type FilesTrpcErrorCode =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL_SERVER_ERROR";

export function mapFilesError(
  error: unknown,
  fallbackMessage: string
): {
  status: FilesHttpStatusCode;
  trpcCode: FilesTrpcErrorCode;
  message: string;
} {
  const message = error instanceof Error ? error.message : fallbackMessage;
  if (error instanceof filesService.FilesAccessDeniedError) {
    return { status: 403, trpcCode: "FORBIDDEN", message };
  }
  if (error instanceof filesService.FilesNotFoundError) {
    return { status: 404, trpcCode: "NOT_FOUND", message };
  }
  if (
    error instanceof filesService.FilesNotDirectoryError ||
    error instanceof filesService.FilesNotFileError
  ) {
    return { status: 400, trpcCode: "BAD_REQUEST", message };
  }
  if (error instanceof filesService.FilesAlreadyExistsError) {
    return { status: 409, trpcCode: "CONFLICT", message };
  }
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST") {
    return {
      status: 409,
      trpcCode: "CONFLICT",
      message: "One or more files already exist",
    };
  }
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EFBIG") {
    return {
      status: 413,
      trpcCode: "PAYLOAD_TOO_LARGE",
      message,
    };
  }
  return {
    status: 500,
    trpcCode: "INTERNAL_SERVER_ERROR",
    message,
  };
}
