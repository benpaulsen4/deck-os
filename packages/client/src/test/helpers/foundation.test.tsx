import { expect, test, vi } from "vitest";
import { authFetch } from "../../lib/auth";
import { MockEventSource } from "./eventSource";
import { mockApiGet } from "./api";
import { renderWithRouter } from "./router";

test("API helper mocks authenticated fetch requests", async () => {
  mockApiGet("/api/health", { status: "ok" });

  const response = await authFetch("/api/health");

  expect(response.ok).toBe(true);
  await expect(response.json()).resolves.toEqual({ status: "ok" });
});

test("EventSource helper dispatches named SSE payloads", () => {
  const onDockerEvent = vi.fn();
  const source = new EventSource("/api/docker/events");
  source.addEventListener("docker-event", onDockerEvent);

  MockEventSource.latest().dispatchMessage("docker-event", { status: "start" });

  expect(onDockerEvent).toHaveBeenCalledTimes(1);
  const payload = onDockerEvent.mock.calls[0]?.[0] as MessageEvent<string>;
  expect(payload.data).toBe(JSON.stringify({ status: "start" }));
});

test("Router helper renders components with router context", async () => {
  const rendered = renderWithRouter(<div>router ready</div>);

  await expect(rendered.findByText("router ready")).resolves.toBeInTheDocument();
});
