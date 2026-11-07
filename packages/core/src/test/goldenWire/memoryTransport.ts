// An in-memory WebSocket between a ChargePoint and the fake CSMS, so that a
// virtual-time run needs no real I/O (no Bun.serve, no real hops): every frame
// is delivered through promise jobs and the event loop turn that
// `drainMicrotasks` waits for. Installed in place of `globalThis.WebSocket`
// for the addresses of one fake CSMS only; any other URL gets the real one.
import type { FakeCsms } from "./FakeCsms";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** What the fake CSMS holds of one connection. */
export interface MemoryServerSocket {
  send(data: string): void;
  close(code?: number): void;
}

/** The client side the charge point's transport talks to. */
class MemoryWebSocket extends EventTarget {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;
  readyState = CONNECTING;
  readonly bufferedAmount = 0;
  readonly extensions = "";
  binaryType: "blob" | "arraybuffer" = "blob";
  readonly protocol: string;

  constructor(
    readonly url: string,
    private readonly csms: FakeCsms,
    protocols: readonly string[],
  ) {
    super();
    this.protocol = protocols[0] ?? "";
    void Promise.resolve().then(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.csms.attachMemoryClient(this.serverSide());
      this.dispatchEvent(new Event("open"));
    });
  }

  private serverSide(): MemoryServerSocket {
    return {
      send: (data) => {
        void Promise.resolve().then(() => {
          if (this.readyState !== OPEN) return;
          this.dispatchEvent(new MessageEvent("message", { data }));
        });
      },
      close: (code = 1000) => this.finish(code, "closed by the CSMS"),
    };
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error("WebSocket is not open");
    void Promise.resolve().then(() => this.csms.receiveFromClient(data));
  }

  ping(): void {}

  close(code = 1000, reason = ""): void {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    void Promise.resolve().then(() => {
      this.csms.memoryClientClosed();
      this.finish(code, reason);
    });
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    void Promise.resolve().then(() => {
      this.csms.memoryClientClosed();
      this.dispatchEvent(new CloseEvent("close", { code, reason }));
    });
  }
}

/**
 * Route `new WebSocket(url)` for `csms.url` to the in-memory transport.
 * Returns the function that puts the real one back.
 */
export function installMemoryTransport(csms: FakeCsms): () => void {
  const real = globalThis.WebSocket;
  const patched = function (
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    if (String(url).startsWith(csms.url)) {
      const list =
        typeof protocols === "string" ? [protocols] : (protocols ?? []);
      return new MemoryWebSocket(String(url), csms, list) as never;
    }
    return new real(url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(patched, {
    CONNECTING,
    OPEN,
    CLOSING,
    CLOSED,
    prototype: real.prototype,
  });
  globalThis.WebSocket = patched;
  return () => {
    if (globalThis.WebSocket === patched) globalThis.WebSocket = real;
  };
}
