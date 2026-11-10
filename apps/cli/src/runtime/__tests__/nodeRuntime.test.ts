// The Node implementations of spawn, file and the path helpers (#916), and
// the runtime selection. Runs under vitest, i.e. on Node.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isBun, runtime } from "..";
import { contentTypeFor, nodeFile } from "../node/file";
import { resolveExecutable, spawnNode } from "../node/spawn";
import { isMainModule, moduleDir } from "../paths";

const dir = mkdtempSync(path.join(tmpdir(), "runtime-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("runtime selection", () => {
  it("picks the Node implementation on Node", () => {
    expect(isBun).toBe(false);
    expect(runtime.name).toBe("node");
  });
});

describe("spawnNode", () => {
  it("pipes stdout and stderr and resolves the exit code", async () => {
    const proc = spawnNode({
      cmd: [
        "node",
        "-e",
        "process.stdout.write('out:' + process.env.X); process.stderr.write('err'); process.exit(3)",
      ],
      env: { ...process.env, X: "42", UNSET: undefined },
    });
    const [out, err, code] = await Promise.all([
      text(proc.stdout),
      text(proc.stderr),
      proc.exited,
    ]);
    expect(out).toBe("out:42");
    expect(err).toBe("err");
    expect(code).toBe(3);
  });

  it("resolves null when the process is killed", async () => {
    const proc = spawnNode({
      cmd: ["node", "-e", "setTimeout(() => {}, 60000)"],
      env: process.env,
    });
    proc.kill();
    expect(await proc.exited).toBeNull();
  });

  it("throws ENOENT synchronously for a missing executable, like Bun.spawn", () => {
    expect(() =>
      spawnNode({ cmd: ["no-such-binary-916"], env: process.env }),
    ).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("looks commands up on the PATH it is given", () => {
    const bin = path.join(dir, "fake-tool");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(resolveExecutable("fake-tool", { PATH: dir })).toBe(bin);
    expect(resolveExecutable("fake-tool", { PATH: "/nonexistent" })).toBe(null);
    expect(resolveExecutable(bin, {})).toBe(bin);
  });
});

describe("nodeFile", () => {
  it("serves a file with the content-type Bun would set", async () => {
    const file = path.join(dir, "index.html");
    writeFileSync(file, "<!doctype html>");
    const f = nodeFile(file);
    expect(await f.exists()).toBe(true);
    const res = await f.response();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html;charset=utf-8");
    expect(await res.text()).toBe("<!doctype html>");
  });

  it("reports a directory or a missing file as not existing", async () => {
    expect(await nodeFile(dir).exists()).toBe(false);
    expect(await nodeFile(path.join(dir, "missing.js")).exists()).toBe(false);
  });

  it("maps the web console's extensions", () => {
    expect(contentTypeFor("/a/b.js")).toBe("text/javascript;charset=utf-8");
    expect(contentTypeFor("x.CSS")).toBe("text/css;charset=utf-8");
    expect(contentTypeFor("f.woff2")).toBe("font/woff2");
    expect(contentTypeFor("i.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("m.webmanifest")).toBe("application/manifest+json");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });
});

describe("paths", () => {
  it("moduleDir prefers Bun's import.meta.dir and falls back to the URL", () => {
    expect(
      moduleDir({ url: "file:///x/y/z.js", dir: "/$bunfs/root" } as never),
    ).toBe("/$bunfs/root");
    expect(moduleDir({ url: pathToFileURL("/x/y/z.js").href } as never)).toBe(
      path.resolve("/x/y"),
    );
  });

  it("isMainModule uses import.meta.main when the runtime sets it", () => {
    expect(isMainModule({ url: "file:///a.js", main: true } as never)).toBe(
      true,
    );
    expect(
      isMainModule({ url: "file:///a.js", main: false } as never, "/a.js"),
    ).toBe(false);
  });

  it("isMainModule compares argv[1] with the module file otherwise", () => {
    const file = path.join(dir, "main.js");
    writeFileSync(file, "");
    const meta = { url: pathToFileURL(file).href } as never;
    expect(isMainModule(meta, file)).toBe(true);
    expect(isMainModule(meta, path.join(dir, "other.js"))).toBe(false);
    expect(isMainModule(meta, undefined)).toBe(false);
  });
});
