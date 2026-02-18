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

export function formatTRPCError(error: TRPCAppError | null): string {
  if (!error) return "";

  if (error.data?.path) {
    return `${error.data.path}: ${error.message}`;
  }

  return error.message;
}
