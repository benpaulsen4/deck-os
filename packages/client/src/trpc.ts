import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "../../server/src/trpc/router.js";

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
    }),
  ],
});

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

export type { AppRouter };
