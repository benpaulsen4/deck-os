import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAppMock,
  withAppLockMock,
  getStackContainersMock,
  removeContainerMock,
  getContainerStatsMock,
  isDeckosManagedContainerMock,
  startStackMock,
} = vi.hoisted(() => ({
  getAppMock: vi.fn(),
  withAppLockMock: vi.fn(async (_appId: string, fn: () => Promise<unknown>) => await fn()),
  getStackContainersMock: vi.fn(),
  removeContainerMock: vi.fn(async () => undefined),
  getContainerStatsMock: vi.fn(async () => ({ cpu: 1, memory: 2, memoryBytes: 3 })),
  isDeckosManagedContainerMock: vi.fn(async () => true),
  startStackMock: vi.fn(async () => undefined),
}));

vi.mock("../services/apps.js", () => ({
  getApp: getAppMock,
  withAppLock: withAppLockMock,
}));

vi.mock("../services/docker.js", () => ({
  getStackContainers: getStackContainersMock,
  removeContainer: removeContainerMock,
  getContainerStats: getContainerStatsMock,
  isDeckosManagedContainer: isDeckosManagedContainerMock,
  startStack: startStackMock,
}));

import { dockerRouter } from "./docker.js";

const caller = dockerRouter.createCaller({
  authEnabled: false,
  isAuthenticated: true,
  sessionToken: null,
  clientIp: "127.0.0.1",
});

const CONTAINER_ID = "a".repeat(64);
const OTHER_CONTAINER_ID = "b".repeat(64);

function containerFixture(id: string, status: string) {
  return {
    id,
    names: ["/web"],
    image: "nginx:latest",
    imageId: "img-1",
    created: 1,
    state: {
      status,
      running: status === "running",
      paused: false,
      restarting: false,
      dead: false,
      pid: 0,
    },
    status,
  };
}

describe("docker router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withAppLockMock.mockImplementation(
      async (_appId: string, fn: () => Promise<unknown>) => await fn()
    );
    isDeckosManagedContainerMock.mockResolvedValue(true);
    getContainerStatsMock.mockResolvedValue({ cpu: 1, memory: 2, memoryBytes: 3 });
    getAppMock.mockResolvedValue({
      id: "app-1",
      metadata: {
        id: "app-1",
        name: "App",
        icon: "",
        url: "",
        description: "",
        order: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      composeYaml: "services: {}",
    });
  });

  it("removes a single unknown container from the requested app stack", async () => {
    getStackContainersMock.mockResolvedValue([containerFixture(CONTAINER_ID, "created")]);

    await expect(
      caller.removeContainer({ appId: "app-1", containerId: CONTAINER_ID })
    ).resolves.toEqual({ success: true });

    expect(removeContainerMock).toHaveBeenCalledWith(CONTAINER_ID);
  });

  it("rejects removing a container that is not in unknown state", async () => {
    const expectedError: Partial<TRPCError> = {
      code: "BAD_REQUEST",
    };

    getStackContainersMock.mockResolvedValue([containerFixture(CONTAINER_ID, "exited")]);

    await expect(
      caller.removeContainer({ appId: "app-1", containerId: CONTAINER_ID })
    ).rejects.toMatchObject(expectedError);

    expect(removeContainerMock).not.toHaveBeenCalled();
  });

  it("rejects container ids that are not docker hex ids", async () => {
    await expect(
      caller.removeContainer({ appId: "app-1", containerId: "not-a-container-id" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.getContainerStats({ containerId: "../../etc/passwd" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(getContainerStatsMock).not.toHaveBeenCalled();
  });

  it("getContainerStats verifies stack membership when an appId is supplied", async () => {
    getStackContainersMock.mockResolvedValue([containerFixture(CONTAINER_ID, "running")]);

    await expect(
      caller.getContainerStats({ appId: "app-1", containerId: CONTAINER_ID })
    ).resolves.toEqual({ cpu: 1, memory: 2, memoryBytes: 3 });

    await expect(
      caller.getContainerStats({ appId: "app-1", containerId: OTHER_CONTAINER_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(getContainerStatsMock).toHaveBeenCalledTimes(1);
  });

  it("getContainerStats refuses containers DeckOS does not manage", async () => {
    isDeckosManagedContainerMock.mockResolvedValue(false);

    await expect(
      caller.getContainerStats({ containerId: CONTAINER_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getContainerStatsMock).not.toHaveBeenCalled();

    isDeckosManagedContainerMock.mockResolvedValue(true);
    await expect(caller.getContainerStats({ containerId: CONTAINER_ID })).resolves.toEqual(
      { cpu: 1, memory: 2, memoryBytes: 3 }
    );
  });

  it("runs lifecycle mutations inside the per-app lock", async () => {
    await caller.start({ appId: "app-1" });

    expect(withAppLockMock).toHaveBeenCalledWith("app-1", expect.any(Function));
    expect(startStackMock).toHaveBeenCalledWith("app-1");

    // The app existence check happens inside the critical section, so a delete
    // that lands first cannot be raced by a start that already passed the check.
    const callOrder: string[] = [];
    withAppLockMock.mockImplementation(
      async (_appId: string, fn: () => Promise<unknown>) => {
        callOrder.push("lock");
        return await fn();
      }
    );
    getAppMock.mockImplementation(async () => {
      callOrder.push("getApp");
      return null;
    });

    await expect(caller.start({ appId: "app-1" })).rejects.toThrow("App not found");
    expect(callOrder).toEqual(["lock", "getApp"]);
    expect(startStackMock).toHaveBeenCalledTimes(1);
  });
});
