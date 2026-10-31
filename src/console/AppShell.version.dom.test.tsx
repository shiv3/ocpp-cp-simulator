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

  // The line sits in a footer under the page, not in the 220px sidebar where it
  // wrapped one item per line.
  async function renderFooter(
    opts?: Parameters<typeof renderConsole>[1],
  ): Promise<HTMLElement> {
    const { container, root } = await renderConsole("/", opts);
    cleanup = () => unmount(root);
    await flush();
    return container.querySelector("footer")!;
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

  it("shows the build label and the GitHub link in the footer, not the sidebar", async () => {
    vi.mocked(appBuildLabel).mockReturnValue("v9.9.9");
    const footer = await renderFooter();

    expect(footer.textContent).toContain("ocpp-cp-simulator");
    expect(footer.textContent).toContain("ui v9.9.9");
    expect(footer.querySelector(REPO_LINK)).toBeTruthy();
    expect(
      document.querySelector("aside")!.querySelector(REPO_LINK),
    ).toBeNull();
  });

  it("shows local-dev and keeps the GitHub link for an unstamped local build", async () => {
    vi.mocked(appBuildLabel).mockReturnValue("local-dev");
    const footer = await renderFooter();

    expect(footer.textContent).toContain("ui local-dev");
    expect(footer.querySelector(REPO_LINK)).toBeTruthy();
  });

  function remoteService(version: string, unsubscribe = vi.fn()) {
    const info: ServerInfo = {
      version,
      soap: { publicBaseUrl: null, path: "/ocpp/soap", tunnel: null },
    };
    // Like RemoteChargePointService: the subscription replays the current
    // state synchronously and hands back its cleanup.
    return Object.assign(
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
  }

  it("shows the connected daemon's version from server.info in remote mode", async () => {
    vi.mocked(appBuildLabel).mockReturnValue("v9.9.9");
    const unsubscribe = vi.fn();
    const footer = await renderFooter({
      service: remoteService("1.2.4", unsubscribe),
    });

    expect(footer.textContent).toContain("ui v9.9.9");
    expect(footer.textContent).toContain("daemon v1.2.4");

    await cleanup!();
    cleanup = null;
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("shows a dev daemon build without a v prefix", async () => {
    vi.mocked(appBuildLabel).mockReturnValue("1a2b3c4-dev");
    const footer = await renderFooter({
      service: remoteService("1a2b3c4-dev"),
    });

    expect(footer.textContent).toContain("ui 1a2b3c4-dev");
    expect(footer.textContent).toContain("daemon 1a2b3c4-dev");
    expect(footer.textContent).not.toContain("daemon v1a2b3c4");
  });

  it("shows no daemon version when the service has no server.info (local mode)", async () => {
    vi.mocked(appBuildLabel).mockReturnValue("v9.9.9");
    const footer = await renderFooter({ mode: "local" });

    expect(footer.textContent).not.toContain("daemon");
  });
});
