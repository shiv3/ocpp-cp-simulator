import { afterEach, describe, expect, it, vi } from "vitest";

import { createLifecycle } from "../lifecycle";
import type { CPRegistry } from "../CPRegistry";

function fakeRegistry() {
  return { shutdownAll: vi.fn() } as unknown as CPRegistry & {
    shutdownAll: ReturnType<typeof vi.fn>;
  };
}

describe("createLifecycle.requestShutdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes the tunnel first, then the listeners and the registry, and exits with the requested code (#183)", () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const order: string[] = [];
    const registry = fakeRegistry();
    registry.shutdownAll.mockImplementation(() => order.push("registry"));
    const lifecycle = createLifecycle({
      pidPath: null,
      registry,
      onShutdownStart: () => order.push("tunnel"),
    });
    lifecycle.attachServer({
      stop: () => order.push("server"),
    } as never);

    lifecycle.requestShutdown(1);

    expect(order).toEqual(["tunnel", "server", "registry"]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 0 by default and ignores a second request", () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const registry = fakeRegistry();
    const lifecycle = createLifecycle({ pidPath: null, registry });

    lifecycle.requestShutdown();
    lifecycle.requestShutdown(1);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(registry.shutdownAll).toHaveBeenCalledTimes(1);
  });
});
