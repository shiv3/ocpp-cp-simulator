// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerInfo } from "../../protocol";
import type { RemoteConnectionState } from "../remote/RemoteChargePointService";
import { useServerInfo } from "./useServerInfo";

interface FakeService {
  getServerInfo: () => Promise<ServerInfo | null>;
  onConnectionChange?: (
    handler: (state: RemoteConnectionState) => void,
  ) => () => void;
}

let service: FakeService;

vi.mock("../providers/DataProvider", () => ({
  useDataContext: () => ({ chargePointService: service }),
}));

const info = (base: string): ServerInfo => ({
  version: "0.0.0",
  soap: { publicBaseUrl: base, path: "/ocpp/soap", tunnel: null },
});

function Consumer(): JSX.Element {
  const serverInfo = useServerInfo();
  return (
    <div data-testid="base">{serverInfo?.soap.publicBaseUrl ?? "none"}</div>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderConsumer(): Promise<{
  container: HTMLElement;
  root: Root;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Consumer />);
  });
  await flush();
  return { container, root };
}

function base(container: HTMLElement): string {
  return container.querySelector('[data-testid="base"]')?.textContent ?? "";
}

describe("useServerInfo (#183)", () => {
  let roots: Root[];

  beforeEach(() => {
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    for (const root of roots) {
      act(() => {
        root.unmount();
      });
    }
    document.body.innerHTML = "";
  });

  it("fetches once per service and shares the result between mounts", async () => {
    service = {
      getServerInfo: vi.fn().mockResolvedValue(info("https://one.test")),
    };
    const first = await renderConsumer();
    roots.push(first.root);
    expect(base(first.container)).toBe("https://one.test");

    const second = await renderConsumer();
    roots.push(second.root);
    expect(base(second.container)).toBe("https://one.test");
    expect(service.getServerInfo).toHaveBeenCalledTimes(1);
  });

  it("refetches when the daemon connection comes back: a restarted daemon may have a new tunnel URL", async () => {
    let connection: ((state: RemoteConnectionState) => void) | null = null;
    const unsubscribe = vi.fn();
    const getServerInfo = vi
      .fn<() => Promise<ServerInfo | null>>()
      .mockResolvedValueOnce(info("https://run-one.ngrok-free.app"))
      .mockResolvedValueOnce(info("https://run-two.ngrok-free.app"));
    service = {
      getServerInfo,
      onConnectionChange: vi.fn((handler) => {
        connection = handler;
        handler("connected");
        return unsubscribe;
      }),
    };
    const rendered = await renderConsumer();
    roots.push(rendered.root);
    expect(base(rendered.container)).toBe("https://run-one.ngrok-free.app");

    await act(async () => {
      connection?.("connecting");
    });
    await act(async () => {
      connection?.("connected");
    });
    await flush();
    expect(base(rendered.container)).toBe("https://run-two.ngrok-free.app");
    expect(getServerInfo).toHaveBeenCalledTimes(2);

    act(() => {
      rendered.root.unmount();
    });
    roots = [];
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("retries after a failed request instead of staying null", async () => {
    let connection: ((state: RemoteConnectionState) => void) | null = null;
    const getServerInfo = vi
      .fn<() => Promise<ServerInfo | null>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(info("https://recovered.test"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    service = {
      getServerInfo,
      onConnectionChange: vi.fn((handler) => {
        connection = handler;
        handler("connected");
        return () => {};
      }),
    };
    const rendered = await renderConsumer();
    roots.push(rendered.root);
    expect(base(rendered.container)).toBe("none");

    await act(async () => {
      connection?.("connecting");
    });
    await act(async () => {
      connection?.("connected");
    });
    await flush();
    expect(base(rendered.container)).toBe("https://recovered.test");
  });
});
