import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * `--blueprint <file>` end to end (#331): the real CLI either starts with the
 * file's blueprints or exits 1 naming the file, before anything listens.
 */
const main = new URL("../main.ts", import.meta.url).pathname;
const sample = new URL(
  "../../../../docs/examples/blueprints/abb-terra-ac-22kw-socket-fw1.6.6.json",
  import.meta.url,
).pathname;

/** A port nothing listens on right now (`--http-port` refuses 0). */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// The failing cases exit before anything listens, so any valid port will do.
const PORT = "18331";

const run = (...args: string[]) =>
  Bun.spawnSync(["bun", main, ...args], { stderr: "pipe", stdout: "pipe" });

describe("--blueprint (#331)", () => {
  test("a missing file exits 1 and names it", () => {
    const missing = path.join(os.tmpdir(), "no-such-blueprint-331.json");
    const r = run("--http-port", PORT, "--blueprint", missing);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`Error: --blueprint ${missing}: `);
  });

  test("an invalid file exits 1 with the JSON path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-flag-"));
    try {
      const file = path.join(dir, "bad.json");
      fs.writeFileSync(
        file,
        JSON.stringify({ id: "x", name: "x", params: { connectors: 0 } }),
      );
      const r = run("--http-port", PORT, "--blueprint", file);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain(
        `Error: --blueprint ${file}: params.connectors: `,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same sample twice exits 1: an id is defined once", () => {
    const r = run(
      "--http-port",
      PORT,
      "--blueprint",
      sample,
      "--blueprint",
      sample,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(
      'blueprint id "abb-terra-ac-22kw-socket-fw1.6.6" is already defined by',
    );
  });

  test("the shipped sample loads and the server starts", async () => {
    const port = String(await freePort());
    const proc = Bun.spawn(
      ["bun", main, "--http-port", port, "--blueprint", sample],
      {
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    try {
      const decoder = new TextDecoder();
      let seen = "";
      const reader = proc.stderr.getReader();
      const deadline = Date.now() + 20_000;
      while (!/Listening/i.test(seen) && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(
              () => resolve({ done: true, value: undefined }),
              deadline - Date.now(),
            ),
          ),
        ]);
        if (chunk.done) break;
        seen += decoder.decode(chunk.value);
      }
      expect(seen).not.toContain("Error:");
      expect(seen).toMatch(/Listening/i);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 30_000);
});
