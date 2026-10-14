// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createFakeChargePointService, renderConsole } from "./test/harness";
import type { RemoteConnectionState } from "../data/remote/RemoteChargePointService";

/** A fake service that reports a daemon connection state, as
 *  `RemoteChargePointService` does. */
function connectionAwareService(initial: RemoteConnectionState) {
  let state = initial;
  const handlers = new Set<(next: RemoteConnectionState) => void>();
  const service = createFakeChargePointService();
  Object.assign(service, {
    getConnectionState: () => state,
    onConnectionChange: (handler: (next: RemoteConnectionState) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  });
  const change = async (next: RemoteConnectionState) => {
    state = next;
    await act(async () => {
      handlers.forEach((handler) => handler(next));
    });
  };
  return { service, change };
}

function indicator(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>(
    '[data-testid="mode-indicator"]',
  );
  if (!found) throw new Error("no mode indicator");
  return found;
}

function dot(): HTMLElement | null {
  return indicator().querySelector<HTMLElement>('[role="status"]');
}

describe("AppShell: the sidebar's mode indicator (#423)", () => {
  let unmount: (() => void) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
    document.body.innerHTML = "";
  });

  it("Remote: follows the daemon connection, and says when it is lost", async () => {
    const { service, change } = connectionAwareService("connecting");
    const { root } = await renderConsole("/", { service, mode: "remote" });
    unmount = () => act(() => root.unmount());

    expect(dot()?.getAttribute("aria-label")).toBe(
      "Remote connection: checking",
    );

    await change("connected");
    expect(dot()?.getAttribute("aria-label")).toBe(
      "Remote connection: connected",
    );
    expect(dot()?.className).toContain("bg-emerald-500");

    await change("disconnected");
    expect(dot()?.getAttribute("aria-label")).toBe(
      "Remote connection: disconnected",
    );
    expect(dot()?.className).toContain("bg-red-500");
    expect(indicator().getAttribute("title")).toContain(
      "Cannot reach the daemon",
    );
  });

  it("Local: no daemon, so no connection status", async () => {
    const { root } = await renderConsole("/", { mode: "local" });
    unmount = () => act(() => root.unmount());

    expect(indicator().textContent).toContain("Local mode");
    expect(dot()).toBeNull();
  });
});
