import { vi } from "vitest";

type Listener = (event: Event) => void;

export class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  readonly withCredentials = false;
  readyState = 0;
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent<string>) => unknown) | null = null;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = 2;
  }

  dispatchOpen(): void {
    this.readyState = 1;
    const event = new Event("open");
    this.onopen?.call(this as unknown as EventSource, event);
  }

  dispatchError(error?: unknown): void {
    this.readyState = 0;
    const event = new Event("error");
    Object.assign(event, { error });
    this.onerror?.call(this as unknown as EventSource, event);
  }

  dispatchMessage(type: string, data: unknown): void {
    const messageEvent = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    if (type === "message") {
      this.onmessage?.call(this as unknown as EventSource, messageEvent);
    }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(messageEvent);
    }
  }

  static latest(): MockEventSource {
    const current = MockEventSource.instances.at(-1);
    if (!current) {
      throw new Error("No EventSource instance is active");
    }
    return current;
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}

export function installEventSourceMock(): void {
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
}

export function resetEventSourceMocks(): void {
  for (const instance of MockEventSource.instances) {
    instance.close();
  }
  MockEventSource.reset();
}
