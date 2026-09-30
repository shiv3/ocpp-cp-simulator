// @vitest-environment jsdom
import { act, type JSX } from "react";
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

/** A connection that, like RemoteChargePointService, replays the current state
 *  to each new subscriber and broadcasts every change to all of them. */
function fakeConnection(unsubscribe: () => void = () => {}) {
  const handlers = new Set<(state: RemoteConnectionState) => void>();
  let current: RemoteConnectionState = "connected";
  return {
    onConnectionChange: vi.fn(
      (handler: (state: RemoteConnectionState) => void) => {
        handlers.add(handler);
        handler(current);
        return () => {
          handlers.delete(handler);
          unsubscribe();
        };
      },
    ),
    emit: async (state: RemoteConnectionState) => {
      current = state;
      await act(async () => {
        for (const handler of handlers) handler(state);
      });
    },
  };
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
    const unsubscribe = vi.fn();
    const connection = fakeConnection(unsubscribe);
    const getServerInfo = vi
      .fn<() => Promise<ServerInfo | null>>()
      .mockResolvedValueOnce(info("https://run-one.ngrok-free.app"))
      .mockResolvedValueOnce(info("https://run-two.ngrok-free.app"));
    service = {
      getServerInfo,
      onConnectionChange: connection.onConnectionChange,
    };
    const rendered = await renderConsumer();
    roots.push(rendered.root);
    expect(base(rendered.container)).toBe("https://run-one.ngrok-free.app");

    await connection.emit("connecting");
    await connection.emit("connected");
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
    const connection = fakeConnection();
    const getServerInfo = vi
      .fn<() => Promise<ServerInfo | null>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(info("https://recovered.test"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    service = {
      getServerInfo,
      onConnectionChange: connection.onConnectionChange,
    };
    const rendered = await renderConsumer();
    roots.push(rendered.root);
    expect(base(rendered.container)).toBe("none");

    await connection.emit("connecting");
    await connection.emit("connected");
    await flush();
    expect(base(rendered.container)).toBe("https://recovered.test");
  });

  it("refetches once per reconnect however many components read it (#364: the version line is always mounted)", async () => {
    const connection = fakeConnection();
    const getServerInfo = vi
      .fn<() => Promise<ServerInfo | null>>()
      .mockResolvedValueOnce(info("https://run-one.ngrok-free.app"))
      .mockResolvedValue(info("https://run-two.ngrok-free.app"));
    service = {
      getServerInfo,
      onConnectionChange: connection.onConnectionChange,
    };
    const first = await renderConsumer();
    const second = await renderConsumer();
    roots.push(first.root, second.root);
    expect(getServerInfo).toHaveBeenCalledTimes(1);

    await connection.emit("connecting");
    await connection.emit("connected");
    await flush();
    expect(base(first.container)).toBe("https://run-two.ngrok-free.app");
    expect(base(second.container)).toBe("https://run-two.ngrok-free.app");
    expect(getServerInfo).toHaveBeenCalledTimes(2);
  });
});
