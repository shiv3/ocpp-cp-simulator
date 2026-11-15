// #1033 / #1034: what a failed WebSocket attempt carries, per cause, so the
// simulator can tell "reached no server" and "refused upgrade" apart without
// the close code. Prints the error event's message, error.code / syscall /
// name and any status-like field, then the close. Needs openssl on PATH.
// Run: bun ws-failure-causes.ts   (compare 1.4.3 and 1.4.4)
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bun-ws-causes-"));
function selfSigned(name: string): { cert: string; key: string } {
  Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, `${name}-k.pem`),
      "-out",
      join(dir, `${name}-c.pem`),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stderr: "ignore" },
  );
  return {
    cert: readFileSync(join(dir, `${name}-c.pem`), "utf8"),
    key: readFileSync(join(dir, `${name}-k.pem`), "utf8"),
  };
}
const server = selfSigned("server");
const trustedCa = selfSigned("ca");
const strangerClient = selfSigned("client");

function describeError(e: Event): string {
  const ev = e as ErrorEvent & { error?: Record<string, unknown> };
  const err = ev.error;
  const fields: string[] = [`message=${JSON.stringify(ev.message ?? "")}`];
  if (err && typeof err === "object") {
    for (const key of ["name", "code", "syscall", "errno", "status"]) {
      if (key in err) fields.push(`${key}=${JSON.stringify(err[key])}`);
    }
    const own = Object.keys(err).filter(
      (k) => !["name", "code", "syscall", "errno", "status"].includes(k),
    );
    if (own.length) fields.push(`otherKeys=${own.join(",")}`);
  } else {
    fields.push(`error=${String(err)}`);
  }
  const extra = Object.keys(ev).filter((k) => k !== "isTrusted");
  if (extra.length) fields.push(`eventKeys=${extra.join(",")}`);
  return fields.join(" ");
}

async function probe(name: string, url: string, options?: object) {
  const events: string[] = [];
  const ws = options
    ? new WebSocket(url, options as never)
    : new WebSocket(url, ["ocpp1.6"]);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      events.push("TIMEOUT(5s)");
      resolve();
    }, 5000);
    ws.addEventListener("open", () => events.push("open"));
    ws.addEventListener("error", (e) =>
      events.push(`error(${describeError(e)})`),
    );
    ws.addEventListener("close", (e) => {
      events.push(
        `close(code=${e.code} clean=${e.wasClean} reason=${JSON.stringify(e.reason)})`,
      );
      clearTimeout(timer);
      resolve();
    });
  });
  console.log(`${name}: ${events.join(" -> ")}`);
  try {
    ws.terminate?.();
  } catch {
    ws.close();
  }
}

// Reached no server.
const closed = createServer();
await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
const closedPort = (closed.address() as { port: number }).port;
await new Promise<void>((r) => closed.close(() => r()));
await probe("tcp refused", `ws://127.0.0.1:${closedPort}/`);
await probe("dns failure", "ws://does-not-exist.invalid/");

// Refused upgrade.
for (const [status, headers] of [
  [401, {}],
  [404, {}],
  [302, { location: "http://127.0.0.1:1/elsewhere" }],
] as const) {
  const srv = Bun.serve({
    port: 0,
    fetch: () => new Response("", { status, headers }),
  });
  await probe(`upgrade ${status}`, `ws://127.0.0.1:${srv.port}/`);
  await srv.stop(true);
}

// TLS.
const tlsServer = Bun.serve({
  port: 0,
  tls: { key: server.key, cert: server.cert },
  fetch: (req, srv) =>
    srv.upgrade(req) ? undefined : new Response("no", { status: 400 }),
  websocket: { message() {} },
});
await probe("untrusted server cert", `wss://localhost:${tlsServer.port}/`);
const mtlsServer = Bun.serve({
  port: 0,
  tls: {
    key: server.key,
    cert: server.cert,
    ca: trustedCa.cert,
    requestCert: true,
    rejectUnauthorized: true,
  },
  fetch: (req, srv) =>
    srv.upgrade(req) ? undefined : new Response("no", { status: 400 }),
  websocket: { message() {} },
});
await probe("client cert refused", `wss://localhost:${mtlsServer.port}/`, {
  protocols: ["ocpp1.6"],
  tls: {
    rejectUnauthorized: false,
    cert: strangerClient.cert,
    key: strangerClient.key,
  },
});
await probe("no client cert", `wss://localhost:${mtlsServer.port}/`, {
  protocols: ["ocpp1.6"],
  tls: { rejectUnauthorized: false },
});
const plainServer = Bun.serve({ port: 0, fetch: () => new Response("plain") });
await probe("wss to a plain-HTTP port", `wss://127.0.0.1:${plainServer.port}/`);
await tlsServer.stop(true);
await mtlsServer.stop(true);
await plainServer.stop(true);
