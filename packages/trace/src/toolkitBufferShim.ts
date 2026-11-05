/**
 * `@ocpp-debugkit/toolkit/core` guards every parse entry point with
 * `Buffer.byteLength(input, "utf8")` (dist/core/parseLimits.js) — a Node
 * global that browsers don't have, so every in-browser analysis run threw
 * `ReferenceError: Buffer is not defined` before parsing anything
 * (issue #238). vitest/jsdom runs in Node where `Buffer` always exists,
 * which is why no test caught it.
 *
 * Installs a minimal `byteLength`-only stand-in when (and only when) the
 * global is absent. A real `Buffer` (Node, Bun, tests) is never touched.
 */
export function ensureToolkitBufferShim(): void {
  const holder = globalThis as { Buffer?: unknown };
  if (typeof holder.Buffer !== "undefined") return;
  holder.Buffer = {
    byteLength: (input: string): number =>
      new TextEncoder().encode(input).length,
  };
}
