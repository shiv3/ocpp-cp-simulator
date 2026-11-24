/**
 * WebSocket `readyState` values (RFC 6455 / WHATWG), spelled out so the
 * transport does not read them from a global `WebSocket` that a non-browser
 * host (k6's `k6/websockets`) may not provide.
 */
export const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;
