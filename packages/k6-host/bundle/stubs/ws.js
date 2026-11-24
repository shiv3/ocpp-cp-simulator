// The Node `ws` package is never used in k6: the transport opens its sockets
// through the constructor installed by `installK6WebSocket`.
export class WebSocket {
  constructor() {
    throw new Error("ws is not available in k6");
  }
}
export default WebSocket;
