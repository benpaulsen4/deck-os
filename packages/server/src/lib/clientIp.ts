import type { Context as HonoContext } from "hono";

function normalizeIp(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice("::ffff:".length);
  }
  return trimmed;
}

export function getDirectClientIp(c: HonoContext): string {
  const remoteAddress = (
    c as unknown as {
      env?: {
        incoming?: {
          socket?: {
            remoteAddress?: string;
          };
        };
      };
    }
  ).env?.incoming?.socket?.remoteAddress;
  const normalized = normalizeIp(remoteAddress);
  return normalized || "unknown";
}
