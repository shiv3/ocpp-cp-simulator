// The adapter between the engine's transport and k6's `k6/websockets`.
//
// `openOcppWebSocket` (core) builds `new Ctor(url, { protocols, headers, ... })`
// like Bun's client does; `k6/websockets` takes `(url, protocols, { headers })`.
// This class maps one to the other and exposes the members the transport reads
// (`readyState`, `protocol`, `bufferedAmount`, `ping`, `addEventListener`).
// `installK6WebSocket` hands it to core through `setOcppWebSocketConstructor`:
// no global `WebSocket` is patched.
import { WebSocket as K6WebSocket } from "k6/websockets";
import { k6ConstructorArgs, type BunStyleOptions } from "./k6Args";
import { setOcppWebSocketConstructor } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/wsUrlWithBasic";

export class K6BunStyleWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  private readonly inner: InstanceType<typeof K6WebSocket>;

  constructor(url: string, arg?: string | string[] | BunStyleOptions) {
    const { protocols, params } = k6ConstructorArgs(arg);
    this.inner = new K6WebSocket(url, protocols, params);
  }
  get readyState(): number {
    return this.inner.readyState;
  }
  get bufferedAmount(): number {
    return this.inner.bufferedAmount ?? 0;
  }
  get url(): string {
    return this.inner.url;
  }
  get protocol(): string {
    return this.inner.protocol ?? "";
  }
  get extensions(): string {
    return "";
  }
  get binaryType(): string {
    return this.inner.binaryType;
  }
  set binaryType(value: string) {
    this.inner.binaryType = value;
  }
  send(data: string): void {
    this.inner.send(data);
  }
  ping(): void {
    this.inner.ping?.();
  }
  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void {
    this.inner.addEventListener(type, listener);
  }
  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void {
    this.inner.removeEventListener?.(type, listener);
  }
  dispatchEvent(): boolean {
    return true;
  }
}

/** Make every charge point built from now on open its sockets through k6. */
export function installK6WebSocket(): void {
  setOcppWebSocketConstructor(
    K6BunStyleWebSocket as unknown as Parameters<
      typeof setOcppWebSocketConstructor
    >[0],
  );
}
