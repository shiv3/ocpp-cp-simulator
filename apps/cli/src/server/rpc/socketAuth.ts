import type { Server as SocketIoServer } from "socket.io";
import { parseBasicAuthHeader, credentialsMatch } from "../httpServer";
import type { SocketIoDeps } from "../socketServer";

/**
 * Read the `Authorization` header off a Socket.IO handshake, tolerating both
 * the plain `IncomingHttpHeaders` record (Node/Engine.IO) and a `Headers`
 * instance, plus the rare repeated-header array form.
 */
function handshakeAuthorizationHeader(headers: unknown): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get("authorization");
  }
  const value = (headers as Record<string, unknown>).authorization;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

export function registerSocketAuth(
  io: SocketIoServer,
  expected: SocketIoDeps["webConsoleBasicAuth"],
): void {
  io.use((socket, next) => {
    if (!expected) {
      next();
      return;
    }
    // 1) Explicit Socket.IO `auth` payload — used by the CLI client and any
    //    cross-origin caller that holds the credentials and echoes them in.
    if (socketAuthMatches(socket.handshake.auth, expected)) {
      next();
      return;
    }
    // 2) HTTP `Authorization: Basic` header on the handshake request. The
    //    bundled web console is served from the same origin as this daemon, so
    //    it is loaded behind the browser's Basic Auth prompt; the browser then
    //    replays those cached credentials on the same-origin Socket.IO
    //    handshake. They are opaque to page JS and cannot be copied into the
    //    `auth` payload above, so accepting the header lets the web console
    //    connect under --web-console-basic-auth without a second credential
    //    entry. (A WebSocket upgrade can't carry the header, but Socket.IO
    //    authenticates once at the handshake, before the transport upgrade.)
    const headerCreds = parseBasicAuthHeader(
      handshakeAuthorizationHeader(socket.handshake.headers),
    );
    if (headerCreds && credentialsMatch(headerCreds, expected)) {
      next();
      return;
    }
    next(new Error("unauthorized"));
  });
}

function socketAuthMatches(
  auth: unknown,
  expected: { readonly username: string; readonly password: string },
): boolean {
  const supplied = readSocketAuth(auth);
  if (!supplied) return false;
  return (
    timingSafeStringEqual(supplied.username, expected.username) &&
    timingSafeStringEqual(supplied.password, expected.password)
  );
}

function readSocketAuth(
  auth: unknown,
): { readonly username: string; readonly password: string } | null {
  if (!auth || typeof auth !== "object") return null;
  const record = auth as Record<string, unknown>;
  const username =
    typeof record.user === "string"
      ? record.user
      : typeof record.username === "string"
        ? record.username
        : null;
  const password =
    typeof record.pass === "string"
      ? record.pass
      : typeof record.password === "string"
        ? record.password
        : null;
  if (username === null || password === null) return null;
  return { username, password };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) {
    diff |= ba[i] ^ bb[i];
  }
  return diff === 0;
}
