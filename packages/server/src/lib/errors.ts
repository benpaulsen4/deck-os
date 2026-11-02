import { core, ZodError } from "zod";

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

// One call can fail on thousands of elements, and the message ends up in a toast.
const MAX_REPORTED_ZOD_ISSUES = 3;

/** Lower-cases a sentence or field name into words, so `composeYaml` is "compose yaml". */
function toWords(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(" ");
}

function formatZodIssue({ path, message }: core.$ZodIssue): string {
  if (path.length === 0) {
    return message;
  }
  // A message written for one field already says which it means ("Invalid app id"), but
  // zod's own wording does not, and a nested path says where in the file to look.
  const [field] = path;
  const namesField =
    path.length === 1 &&
    typeof field === "string" &&
    ` ${toWords(message)} `.includes(` ${toWords(field)} `);
  return namesField ? message : `${core.toDotPath(path)}: ${message}`;
}

/** A ZodError's own `message` is its issue list as JSON, which is not for people to read. */
export function formatZodError(error: ZodError): string {
  const reported = error.issues.slice(0, MAX_REPORTED_ZOD_ISSUES).map(formatZodIssue);
  const unreported = error.issues.length - reported.length;
  return [...reported, ...(unreported > 0 ? [`and ${unreported} more`] : [])].join("; ");
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return formatZodError(error);
  }
  if (isError(error)) {
    return error.message;
  }
  return String(error);
}
