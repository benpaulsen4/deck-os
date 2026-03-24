import { HttpResponse, http, type HttpHandler } from "msw";
import { setupServer } from "msw/node";

export const apiServer = setupServer();
type JsonBody = Record<string, unknown> | unknown[] | string | number | boolean | null;

function toApiUrl(pathname: string): string {
  if (pathname.startsWith("http://") || pathname.startsWith("https://")) {
    return pathname;
  }
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `http://localhost:5173${normalizedPath}`;
}

export function mockApiGet(
  pathname: string,
  body: JsonBody,
  options?: { status?: number }
): void {
  apiServer.use(
    http.get(toApiUrl(pathname), () =>
      HttpResponse.json(body, { status: options?.status ?? 200 })
    )
  );
}

export function mockApiPost(
  pathname: string,
  body: JsonBody,
  options?: { status?: number }
): void {
  apiServer.use(
    http.post(toApiUrl(pathname), () =>
      HttpResponse.json(body, { status: options?.status ?? 200 })
    )
  );
}

export function mockApiPut(
  pathname: string,
  body: JsonBody,
  options?: { status?: number }
): void {
  apiServer.use(
    http.put(toApiUrl(pathname), () =>
      HttpResponse.json(body, { status: options?.status ?? 200 })
    )
  );
}

export function mockApiDelete(
  pathname: string,
  body: JsonBody,
  options?: { status?: number }
): void {
  apiServer.use(
    http.delete(toApiUrl(pathname), () =>
      HttpResponse.json(body, { status: options?.status ?? 200 })
    )
  );
}

export function useApiHandler(handler: HttpHandler): void {
  apiServer.use(handler);
}

export { http, HttpResponse };
