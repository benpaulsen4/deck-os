import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "../../server/src/trpc/router.js";

// Vanilla tRPC client (for use outside React)
export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "/api/trpc",
    }),
  ],
});

// React Query integrated tRPC context
export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

export type { AppRouter };
