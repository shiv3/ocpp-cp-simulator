// Problem B1: valid server messages closed by the client with 1002
// "Received new message inside a fragmented message" (seen on 1.4.4 only).
// Variants try to find the trigger: subprotocol, compression, message sizes,
// replies sent from inside the message handler in a burst.
// Run on 1.4.3 / 1.4.4 and compare the lines.
async function run(
  label: string,
  opts: { compress: boolean; proto?: string; size: number; burst: number },
) {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(
        req,
        opts.proto
          ? { headers: { "sec-websocket-protocol": opts.proto } }
          : undefined,
      )
        ? undefined
        : new Response("no", { status: 400 });
    },
    websocket: {
      perMessageDeflate: opts.compress,
      message(ws, msg) {
        for (let b = 0; b < opts.burst; b++)
          ws.send(
            JSON.stringify([3, String(msg), { pad: "x".repeat(opts.size) }]),
            opts.compress,
          );
      },
    },
  });
  const total = 300;
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/`,
    opts.proto ? [opts.proto] : [],
  );
  let received = 0;
  const result = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve(`TIMEOUT after ${received}`), 8000);
    ws.addEventListener("open", () => {
      for (let i = 0; i < total; i++) ws.send(String(i));
    });
    ws.addEventListener("message", () => {
      if (++received === total * opts.burst) {
        clearTimeout(timer);
        resolve("ok");
      }
    });
    ws.addEventListener("close", (e) => {
      clearTimeout(timer);
      resolve(`closed code=${e.code} reason=${e.reason} after ${received}`);
    });
  });
  console.log(`${label}: ${result}`);

  ws.close();
  await server.stop(true);
}
for (const compress of [false, true])
  for (const size of [10, 2000, 70000])
    for (const burst of [1, 3])
      await run(
        `deflate=${compress} size=${size} burst=${burst} proto=ocpp2.0.1`,
        { compress, proto: "ocpp2.0.1", size, burst },
      );
