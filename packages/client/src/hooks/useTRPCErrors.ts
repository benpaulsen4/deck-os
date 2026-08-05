import { useEffect } from "react";
import { useToastStore } from "../stores/toast";

export type TRPCAppError = {
  message: string;
  code?: string;
  data?: {
    code?: string;
    httpStatus?: number;
    path?: string;
  };
};

export function useTRPCErrors(error: TRPCAppError | null) {
  const { addToast } = useToastStore();

  useEffect(() => {
    if (error) {
      const message = error.data?.path
        ? `Error in ${error.data.path}: ${error.message}`
        : error.message;

      addToast(message, "error");

      console.error("tRPC Error:", error);
    }
  }, [error, addToast]);
}

/**
 * The app lifecycle procedures (docker.start/stop/restart/removeContainer) hold
 * a per-app lock and reject with CONFLICT rather than queueing behind a compose
 * command that can run for minutes. A second click landing on a busy app is an
 * expected outcome, not a failure, so those call sites report it as such.
 *
 * Deliberately not applied globally: other routers use CONFLICT for unrelated
 * reasons (the file browser uses it for destination collisions), and "app is
 * busy" would be wrong there.
 */
export const APP_BUSY_MESSAGE = "App is busy - another operation is still running";

export const APP_BUSY_TITLE = "Busy - another operation is still running";

export function isConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as TRPCAppError).data?.code === "CONFLICT";
}

export function formatTRPCError(error: TRPCAppError | null): string {
  if (!error) return "";

  if (error.data?.path) {
    return `${error.data.path}: ${error.message}`;
  }

  return error.message;
}
