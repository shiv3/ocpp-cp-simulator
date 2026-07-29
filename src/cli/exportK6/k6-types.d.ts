// src/cli/exportK6/k6-types.d.ts
// Minimal ambient declarations so the emitted-verbatim runtime typechecks in
// this repo without depending on @types/k6. NOT emitted into export bundles —
// k6 provides the real modules at run time.
declare module "k6" {
  export function check<T>(
    val: T,
    sets: Record<string, (val: T) => boolean>,
  ): boolean;
}

declare module "k6/metrics" {
  export class Trend {
    constructor(name: string, isTime?: boolean);
    add(value: number, tags?: Record<string, string>): void;
  }
  export class Counter {
    constructor(name: string);
    add(value: number, tags?: Record<string, string>): void;
  }
  export class Rate {
    constructor(name: string);
    add(value: boolean | number, tags?: Record<string, string>): void;
  }
}

declare module "k6/timers" {
  export function setTimeout(fn: () => void, delayMs: number): number;
  export function clearTimeout(id: number): void;
  export function setInterval(fn: () => void, delayMs: number): number;
  export function clearInterval(id: number): void;
}

declare module "k6/data" {
  export class SharedArray<T> {
    constructor(name: string, fn: () => T[]);
    readonly length: number;
    [index: number]: T;
  }
}

// Requires k6 >= 1.6.0 (k6/websockets graduated from
// k6/experimental/websockets in grafana/k6#5579); k6/timers above has been
// stable since k6 v0.51.
declare module "k6/websockets" {
  export interface WebSocketParams {
    headers?: Record<string, string>;
  }
  export class WebSocket {
    constructor(
      url: string,
      protocols?: string | string[] | null,
      params?: WebSocketParams,
    );
    send(data: string): void;
    close(code?: number): void;
    addEventListener(
      type: "open" | "message" | "close" | "error",
      handler: (event: { data?: string; error?: unknown }) => void,
    ): void;
  }
}

/** k6 init-context file reader (available in the generated entry + index.ts). */
declare function open(path: string): string;
