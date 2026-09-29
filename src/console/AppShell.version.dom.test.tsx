// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { appBuildLabel } from "@/lib/appBuildLabel";
import type { ServerInfo } from "../protocol";
import type { RemoteConnectionState } from "../data/remote/RemoteChargePointService";
import {
  createFakeChargePointService,
  flush,
  renderConsole,
} from "./test/harness";

// The real label comes from build-time defines, which are unstamped under
// vitest — mock it so both the stamped and unstamped paths are exercised.
vi.mock("@/lib/appBuildLabel", () => ({ appBuildLabel: vi.fn() }));

const REPO_LINK = 'a[href="https://github.com/shiv3/ocpp-cp-simulator"]';

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

describe("AppShell build version (issue #364)", () => {
  let cleanup: (() => Promise<void>) | null = null;

  async function renderAside(
    opts?: Parameters<typeof renderConsole>[1],
  ): Promise<HTMLElement> {
    const { container, root } = await renderConsole("/", opts);
    cleanup = () => unmount(root);
    await flush();
    return container.querySelector("aside")!;
  }

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("shows the build label and the GitHub link in the sidebar, like the classic footer", async () => {
    vi.mocked(appBuildLabel).mockReturnValue("v9.9.9");
    const aside = await renderAside();

    expect(aside.textContent).toContain("ocpp-cp-simulator");
    expect(aside.textContent).toContain("v9.9.9");
    expect(aside.querySelector(REPO_LINK)).toBeTruthy();
  });

  it("hides the version but keeps the GitHub link for an unstamped build", async () => {
    vi.mocked(appBuildLabel).mockReturnValue(null);
    const aside = await renderAside();

    expect(aside.textContent).not.toMatch(/\bv\d/);
    expect(aside.querySelector(REPO_LINK)).toBeTruthy();
  });

  it("shows the connected daemon's version from server.info in remote mode", async () => {
    vi.mocked(appBuildLabel).mockReturnValue("v9.9.9");
    const info: ServerInfo = {
      version: "1.2.4",
      soap: { publicBaseUrl: null, path: "/ocpp/soap", tunnel: null },
    };
    const unsubscribe = vi.fn();
    // Like RemoteChargePointService: the subscription replays the current
    // state synchronously and hands back its cleanup.
    const service = Object.assign(
      createFakeChargePointService({
        getServerInfo: vi.fn(async () => info),
      }),
      {
        onConnectionChange: vi.fn(
          (handler: (state: RemoteConnectionState) => void) => {
            handler("connected");
            return unsubscribe;
          },
        ),
      },
    );
    const aside = await renderAside({ service });

    expect(aside.textContent).toContain("v9.9.9");
    expect(aside.textContent).toContain("daemon v1.2.4");

    await cleanup!();
    cleanup = null;
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("shows no daemon version when the service has no server.info (local mode)", async () => {
    vi.mocked(appBuildLabel).mockReturnValue("v9.9.9");
    const aside = await renderAside({ mode: "local" });

    expect(aside.textContent).not.toContain("daemon");
  });
});
