import { create } from "zustand";
import type { ToastType } from "../components/ui/Toast";

interface ToastState {
  toasts: Array<{ id: string; message: string; type: ToastType }>;
  addToast: (message: string, type?: ToastType) => void;
  removeToast: (id: string) => void;
}

const createToastId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const randomPart = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${Date.now()}-${randomPart}`;
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (message, type = "info") =>
    set((state) => ({
      toasts: [...state.toasts, { id: createToastId(), message, type }],
    })),
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}));
