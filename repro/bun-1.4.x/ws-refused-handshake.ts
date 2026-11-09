// Problem B2: how a Bun WebSocket client reports a refused upgrade.
// Run: bun ws-refused-handshake.ts   (compare 1.4.3 and 1.4.4)
const cases: Array<[string, number, Record<string, string>]> = [
  ["401", 401, {}],
  ["404", 404, {}],
  ["302", 302, { location: "http://127.0.0.1:1/elsewhere" }],
];

for (const [name, status, headers] of cases) {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("", { status, headers }),
  });
  const events: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`, ["ocpp1.6"]);
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      events.push("TIMEOUT(3s)");
      resolve();
    }, 3000);
    ws.addEventListener("open", () => events.push("open"));
    ws.addEventListener("error", (e) =>
      events.push(`error(${(e as ErrorEvent).message ?? ""})`),
    );
    ws.addEventListener("close", (e) => {
      events.push(
        `close(code=${e.code} clean=${e.wasClean} reason=${e.reason})`,
      );
      clearTimeout(timer);
      resolve();
    });
  });
  await done;
  console.log(`${name}: ${events.join(" -> ")}`);

  ws.close();
  await server.stop(true);
}
