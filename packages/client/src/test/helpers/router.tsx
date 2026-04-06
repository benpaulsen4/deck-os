import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";
import type { TRPCClient } from "@trpc/client";
import type { ReactNode } from "react";
import { TRPCProvider, trpcClient, type AppRouter } from "../../trpc";
import { routeTree } from "../../routeTree.gen";

type TestRenderOptions = {
  initialEntries?: string[];
  queryClient?: QueryClient;
  trpc?: TRPCClient<AppRouter>;
};

type RouterRenderResult = RenderResult & {
  router: unknown;
  queryClient: QueryClient;
};

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export function renderWithAppRouter(
  options: TestRenderOptions = {}
): RouterRenderResult {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: options.initialEntries ?? ["/"],
    }),
  });
  void router.load();

  const result = render(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={options.trpc ?? trpcClient} queryClient={queryClient}>
        <RouterProvider router={router} />
      </TRPCProvider>
    </QueryClientProvider>
  );
  return { ...result, router, queryClient };
}

export function renderWithRouter(
  ui: ReactNode,
  options: TestRenderOptions = {}
): RouterRenderResult {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({
      initialEntries: options.initialEntries ?? ["/"],
    }),
  });
  void router.load();

  const result = render(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={options.trpc ?? trpcClient} queryClient={queryClient}>
        <RouterProvider router={router} />
      </TRPCProvider>
    </QueryClientProvider>
  );
  return { ...result, router, queryClient };
}
