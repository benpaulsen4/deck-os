export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class AppNotFoundError extends AppError {
  constructor(appId: string) {
    super(`App not found: ${appId}`, "APP_NOT_FOUND", 404);
    this.name = "AppNotFoundError";
  }
}

export class ComposeValidationError extends AppError {
  constructor(message: string) {
    super(`Invalid compose YAML: ${message}`, "COMPOSE_VALIDATION_ERROR", 400);
    this.name = "ComposeValidationError";
  }
}

export class DockerUnavailableError extends AppError {
  constructor() {
    super(
      "Docker is not available. Please ensure Docker is running and the socket is accessible.",
      "DOCKER_UNAVAILABLE",
      503
    );
    this.name = "DockerUnavailableError";
  }
}

export class DockerOperationError extends AppError {
  constructor(operation: string, reason: string) {
    super(
      `Docker operation '${operation}' failed: ${reason}`,
      "DOCKER_OPERATION_ERROR",
      500
    );
    this.name = "DockerOperationError";
  }
}

export class PullAbortedError extends AppError {
  constructor() {
    super("Pull operation was aborted", "PULL_ABORTED", 499);
    this.name = "PullAbortedError";
  }
}

export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  return String(error);
}
