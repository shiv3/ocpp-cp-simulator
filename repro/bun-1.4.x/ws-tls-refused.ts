// Problem B3: how a refused wss:// connection closes. A self-signed server is
// refused by default; a plain-HTTP port is not a TLS peer at all.
// Needs openssl on PATH to make the certificate. Run on 1.4.3 / 1.4.4.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bun-tls-"));
Bun.spawnSync(
  [
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(dir, "k.pem"),
    "-out",
    join(dir, "c.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
  ],
  { stderr: "ignore" },
);

const tlsServer = Bun.serve({
  port: 0,
  tls: {
    key: readFileSync(join(dir, "k.pem")),
    cert: readFileSync(join(dir, "c.pem")),
  },
  fetch(req, srv) {
    return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
  },
  websocket: { message() {} },
});
const plainServer = Bun.serve({ port: 0, fetch: () => new Response("plain") });

async function probe(name: string, url: string) {
  const events: string[] = [];
  const ws = new WebSocket(url);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      events.push("TIMEOUT(3s)");
      resolve();
    }, 3000);
    ws.addEventListener("open", () => events.push("open"));
    ws.addEventListener("error", () => events.push("error"));
    ws.addEventListener("close", (e) => {
      events.push(`close(code=${e.code} clean=${e.wasClean})`);
      clearTimeout(timer);
      resolve();
    });
  });
  console.log(`${name}: ${events.join(" -> ")}`);

  ws.close();
}
await probe("self-signed cert", `wss://localhost:${tlsServer.port}/`);
await probe("wss to a plain-HTTP port", `wss://127.0.0.1:${plainServer.port}/`);
await probe("ws to a TLS port", `ws://127.0.0.1:${tlsServer.port}/`);
await tlsServer.stop(true);
await plainServer.stop(true);
