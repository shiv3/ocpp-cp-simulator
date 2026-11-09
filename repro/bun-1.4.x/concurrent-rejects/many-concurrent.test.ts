// Problem A, file 1: many test.concurrent cases, each with its OWN Bun.serve
// and WebSocket client, a short exchange, a timer left pending, then teardown
// with server.stop(true) raced against a 50 ms timer.
import { test } from "bun:test";

const CASES = Number(process.env.CASES ?? 340);

for (let i = 0; i < CASES; i++) {
  test.concurrent(
    `case ${i}`,
    async () => {
      const server = Bun.serve({
        port: 0,
        fetch(req, srv) {
          return srv.upgrade(req)
            ? undefined
            : new Response("no", { status: 400 });
        },
        websocket: {
          message(ws, m) {
            ws.send(m);
          },
        },
      });
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
      await new Promise<void>((resolve, reject) => {
        let n = 0;
        ws.onopen = () => ws.send("0");
        ws.onmessage = () => (++n < 20 ? ws.send(String(n)) : resolve());
        ws.onerror = () => reject(new Error("ws error"));
      });
      const keepAlive = setInterval(() => {}, 60_000); // a timer the case forgets
      ws.close();
      await Promise.race([
        server.stop(true),
        new Promise((r) => setTimeout(r, 50)),
      ]);
      clearInterval(keepAlive);
    },
    90_000,
  );
}
