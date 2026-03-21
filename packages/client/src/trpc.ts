import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "../../server/src/trpc/router.js";
import { emitUnauthorizedEvent } from "./lib/auth";

const getApiUrl = (): string => {
  if (typeof window !== "undefined") {
    return "/api/trpc";
  }
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}/api/trpc`;
};

export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: getApiUrl(),
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (response.status === 401) {
          emitUnauthorizedEvent();
        }
        return response;
      },
    }),
  ],
});

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

export type { AppRouter };
