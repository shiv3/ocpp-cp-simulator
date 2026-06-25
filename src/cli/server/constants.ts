/** Default Unix-domain-socket path for the daemon's HTTP server. Kept in its
 *  own lean module (no `bun:sqlite` / server imports) so lightweight callers
 *  like the CLI client can reference it without pulling in the whole server. */
export const DEFAULT_UNIX_SOCKET = "/tmp/ocpp-server.sock";

/** Default TCP HTTP/socket.io port for the daemon. */
export const DEFAULT_HTTP_PORT = 9700;
