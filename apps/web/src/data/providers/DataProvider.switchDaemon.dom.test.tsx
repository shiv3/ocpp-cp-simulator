// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_DAEMON_KEY } from "../savedDaemons";

/**
 * #619: switching daemons. The probe, the connection wait, the rollback of a
 * failed switch and the stored choice run for real; only the remote service
 * (a socket) and `fetch` are stubbed.
 */

const connected = new Set<string>();

vi.mock("@ocpp-cp-simulator/client/remote/RemoteChargePointService", () => ({
  RemoteChargePointService: class {
    constructor(private readonly url: string) {}
    getConnectionState() {
      return connected.has(this.url) ? "connected" : "connecting";
    }
    dispose() {}
    async applyDefaultEVSettings() {}
  },
}));

import { DataProvider, useDataContext } from "./DataProvider";

const ORIGIN = "http://origin:9700";
const TARGET = "http://other:9700";

let latest: ReturnType<typeof useDataContext> | null = null;
function Probe() {
  latest = useDataContext();
  return null;
}

let root: Root;
let container: HTMLDivElement;
let healthy: Set<string>;

beforeEach(() => {
  vi.useFakeTimers();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  connected.clear();
  connected.add(ORIGIN);
  healthy = new Set([ORIGIN, TARGET]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const ok = [...healthy].some((h) => String(input).startsWith(h));
      return {
        ok,
        status: ok ? 200 : 503,
        json: async () => ({ ok }),
      };
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(
      <DataProvider modeOverride="remote" serverUrlOverride={ORIGIN}>
        <Probe />
      </DataProvider>,
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}

describe("DataProvider.switchDaemon (#619)", () => {
  it("switches once the target answers and connects, and remembers it", async () => {
    await mount();
    connected.add(TARGET);
    let done: Promise<void> | undefined;
    await act(async () => {
      done = latest!.switchDaemon!(TARGET);
      await vi.advanceTimersByTimeAsync(10);
    });
    // React commits the new service between these two steps.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      await done;
    });
    expect(latest!.serverUrl).toBe(TARGET);
    expect(window.localStorage.getItem(ACTIVE_DAEMON_KEY)).toBe(TARGET);
  });

  it("rejects an unreachable daemon without switching", async () => {
    await mount();
    healthy.delete(TARGET);
    let error: unknown;
    await act(async () => {
      await latest!.switchDaemon!(TARGET).catch((e) => (error = e));
    });
    expect(error).toBeInstanceOf(Error);
    expect(latest!.serverUrl).toBe(ORIGIN);
    expect(window.localStorage.getItem(ACTIVE_DAEMON_KEY)).toBeNull();
  });

  it("returns to the previous daemon when the new one never connects", async () => {
    await mount();
    // TARGET answers its probe but its socket never connects.
    let error: unknown;
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = latest!.switchDaemon!(TARGET).catch((e) => (error = e));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(latest!.serverUrl).toBe(TARGET);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
      await pending;
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/timed out/);
    expect(latest!.serverUrl).toBe(ORIGIN);
    expect(window.localStorage.getItem(ACTIVE_DAEMON_KEY)).toBeNull();
  });

  it("a superseded switch neither commits nor rolls back over the newer one", async () => {
    await mount();
    const THIRD = "http://third:9700";
    healthy.add(THIRD);
    connected.add(THIRD);
    let first: Promise<unknown> | undefined;
    await act(async () => {
      // TARGET never connects; THIRD does and starts before TARGET gives up.
      first = latest!.switchDaemon!(TARGET).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(100);
      void latest!.switchDaemon!(THIRD);
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
      await first;
    });
    expect(latest!.serverUrl).toBe(THIRD);
    expect(window.localStorage.getItem(ACTIVE_DAEMON_KEY)).toBe(THIRD);
  });
});
