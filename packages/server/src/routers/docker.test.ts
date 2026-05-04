import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAppMock, getStackContainersMock, removeContainerMock } = vi.hoisted(() => ({
  getAppMock: vi.fn(),
  getStackContainersMock: vi.fn(),
  removeContainerMock: vi.fn(async () => undefined),
}));

vi.mock("../services/apps.js", () => ({
  getApp: getAppMock,
}));

vi.mock("../services/docker.js", () => ({
  getStackContainers: getStackContainersMock,
  removeContainer: removeContainerMock,
}));

import { dockerRouter } from "./docker.js";

const caller = dockerRouter.createCaller({
  authEnabled: false,
  isAuthenticated: true,
  sessionToken: null,
  clientIp: "127.0.0.1",
});

describe("docker router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    getStackContainersMock.mockResolvedValue([
      {
        id: "cid-unknown",
        names: ["/old-web"],
        image: "nginx:latest",
        imageId: "img-1",
        created: 1,
        state: {
          status: "created",
          running: false,
          paused: false,
          restarting: false,
          dead: false,
          pid: 0,
        },
        status: "Created",
      },
    ]);

    await expect(
      caller.removeContainer({ appId: "app-1", containerId: "cid-unknown" })
    ).resolves.toEqual({ success: true });

    expect(removeContainerMock).toHaveBeenCalledWith("cid-unknown");
  });

  it("rejects removing a container that is not in unknown state", async () => {
    getStackContainersMock.mockResolvedValue([
      {
        id: "cid-stopped",
        names: ["/web"],
        image: "nginx:latest",
        imageId: "img-1",
        created: 1,
        state: {
          status: "exited",
          running: false,
          paused: false,
          restarting: false,
          dead: false,
          pid: 0,
        },
        status: "Exited (0)",
      },
    ]);

    await expect(
      caller.removeContainer({ appId: "app-1", containerId: "cid-stopped" })
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "BAD_REQUEST",
    });

    expect(removeContainerMock).not.toHaveBeenCalled();
  });
});
