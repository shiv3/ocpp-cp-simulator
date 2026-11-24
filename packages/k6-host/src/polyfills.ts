// Web globals the simulator's engine reads and k6's JavaScript engine (Sobek)
// does not have. `installPolyfills` adds each one only when it is missing, so
// it is a no-op under Bun and Node and testable there against a bare object.
// Measured on k6 v2.4 (#1126): URL, URLSearchParams, queueMicrotask,
// AbortController/AbortSignal, EventTarget/Event, btoa/atob, structuredClone,
// performance and setImmediate are absent; Promise, Proxy, BigInt,
// TextEncoder, crypto.getRandomValues/randomUUID, timers and `new Function`
// (ajv) are there.
//
// This file imports nothing from k6 or from the repo, so a unit test can load it.

type Target = Record<string, unknown>;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** `btoa` for a binary string (every char code <= 255). */
export function base64Encode(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i += 3) {
    const a = input.charCodeAt(i);
    const b = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
    const c = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN;
    if (a > 255 || b > 255 || c > 255) {
      throw new Error("btoa: string contains characters outside Latin1");
    }
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += Number.isNaN(b) ? "=" : B64[(n >> 6) & 63];
    out += Number.isNaN(c) ? "=" : B64[n & 63];
  }
  return out;
}

/** `atob`: base64 text to a binary string. */
export function base64Decode(input: string): string {
  const clean = input.replace(/[\s=]+$/g, "").replace(/\s+/g, "");
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("atob: invalid base64 character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 255);
    }
  }
  return out;
}

export class PolyfillEvent {
  defaultPrevented = false;
  constructor(
    readonly type: string,
    init?: Record<string, unknown>,
  ) {
    if (init) Object.assign(this, init);
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

type Listener =
  | ((event: PolyfillEvent) => void)
  | { handleEvent(event: PolyfillEvent): void };

export class PolyfillEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: PolyfillEvent): boolean {
    for (const l of [...(this.listeners.get(event.type) ?? [])]) {
      if (typeof l === "function") l.call(this, event);
      else l.handleEvent(event);
    }
    return !event.defaultPrevented;
  }
}

export class PolyfillAbortSignal extends PolyfillEventTarget {
  aborted = false;
  reason: unknown = undefined;
  onabort: ((event: PolyfillEvent) => void) | null = null;
  static timeout(ms: number): PolyfillAbortSignal {
    const controller = new PolyfillAbortController();
    setTimeout(() => controller.abort(new Error("TimeoutError")), ms);
    return controller.signal;
  }
  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }
}

export class PolyfillAbortController {
  readonly signal = new PolyfillAbortSignal();
  abort(reason?: unknown): void {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason;
    const event = new PolyfillEvent("abort");
    this.signal.onabort?.(event);
    this.signal.dispatchEvent(event);
  }
}

export class PolyfillURLSearchParams {
  private pairs: [string, string][] = [];
  constructor(init?: string) {
    if (!init) return;
    for (const kv of init.replace(/^\?/, "").split("&")) {
      if (!kv) continue;
      const eq = kv.indexOf("=");
      const k = eq < 0 ? kv : kv.slice(0, eq);
      const v = eq < 0 ? "" : kv.slice(eq + 1);
      this.pairs.push([decode(k), decode(v)]);
    }
  }
  set(key: string, value: string): void {
    const first = this.pairs.findIndex((p) => p[0] === key);
    if (first < 0) {
      this.pairs.push([key, String(value)]);
      return;
    }
    this.pairs[first]![1] = String(value);
    this.pairs = this.pairs.filter((p, i) => p[0] !== key || i === first);
  }
  append(key: string, value: string): void {
    this.pairs.push([key, String(value)]);
  }
  get(key: string): string | null {
    return this.pairs.find((p) => p[0] === key)?.[1] ?? null;
  }
  has(key: string): boolean {
    return this.pairs.some((p) => p[0] === key);
  }
  delete(key: string): void {
    this.pairs = this.pairs.filter((p) => p[0] !== key);
  }
  toString(): string {
    return this.pairs
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
  }
}

function decode(s: string): string {
  return decodeURIComponent(s.replace(/\+/g, " "));
}

const DEFAULT_PORTS: Record<string, string> = {
  "ws:": "80",
  "wss:": "443",
  "http:": "80",
  "https:": "443",
};

const URL_RE =
  /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?(\[[^\]]+\]|[^:/?#]*)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/;

/**
 * The subset of WHATWG `URL` the engine uses: absolute `ws(s)://` and
 * `http(s)://` URLs with optional credentials, port, path, query and
 * hash. Anything else throws `TypeError`, as `new URL` does for a malformed
 * input.
 */
export class PolyfillURL {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
  pathname: string;
  hash: string;
  searchParams: PolyfillURLSearchParams;
  private rawQuery: string;

  constructor(href: string) {
    const m = URL_RE.exec(String(href));
    if (!m) throw new TypeError(`Invalid URL: ${href}`);
    this.protocol = m[1]!.toLowerCase();
    this.username = m[2] ?? "";
    this.password = m[3] ?? "";
    this.hostname = m[4]!.toLowerCase();
    this.port = m[5] ?? "";
    this.pathname = (m[6] || "/").replace(/ /g, "%20");
    this.rawQuery = m[7] ?? "";
    this.hash = m[8] ?? "";
    this.searchParams = new PolyfillURLSearchParams(this.rawQuery);
    if (this.port === DEFAULT_PORTS[this.protocol]) this.port = "";
  }
  get search(): string {
    const s = this.searchParams.toString();
    if (s) return `?${s}`;
    return this.rawQuery.length > 1 ? this.rawQuery : "";
  }
  set search(value: string) {
    this.rawQuery = value;
    this.searchParams = new PolyfillURLSearchParams(value);
  }
  get host(): string {
    return this.hostname + (this.port ? `:${this.port}` : "");
  }
  get origin(): string {
    return `${this.protocol}//${this.host}`;
  }
  get href(): string {
    const auth = this.username
      ? `${this.username}${this.password ? `:${this.password}` : ""}@`
      : "";
    return `${this.protocol}//${auth}${this.host}${this.pathname}${this.search}${this.hash}`;
  }
  toString(): string {
    return this.href;
  }
}

/** Add every missing global to `target` (default `globalThis`). */
export function installPolyfills(target: Target = globalThis as Target): void {
  const missing = (name: string): boolean =>
    typeof target[name] === "undefined";
  if (typeof target.queueMicrotask !== "function") {
    target.queueMicrotask = (fn: () => void): void => {
      void Promise.resolve().then(fn);
    };
  }
  if (typeof target.setImmediate !== "function") {
    target.setImmediate = (fn: () => void): unknown => setTimeout(fn, 0);
  }
  if (typeof target.btoa !== "function") target.btoa = base64Encode;
  if (typeof target.atob !== "function") target.atob = base64Decode;
  if (missing("performance")) target.performance = { now: () => Date.now() };
  if (typeof target.structuredClone !== "function") {
    target.structuredClone = (v: unknown): unknown =>
      v === undefined ? v : JSON.parse(JSON.stringify(v));
  }
  if (missing("EventTarget")) {
    target.Event = PolyfillEvent;
    target.EventTarget = PolyfillEventTarget;
  }
  if (missing("AbortController")) {
    target.AbortSignal = PolyfillAbortSignal;
    target.AbortController = PolyfillAbortController;
  }
  if (missing("URLSearchParams"))
    target.URLSearchParams = PolyfillURLSearchParams;
  if (missing("URL")) target.URL = PolyfillURL;
}
