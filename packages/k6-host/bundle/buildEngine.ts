// Bundles the engine (`src/entry.ts`: the real ChargePoint, ScenarioExecutor
// and charger engine of packages/core, plus the k6 host shims) into one ES
// module for k6. Needs Bun (`Bun.build`).
//
// Lean on purpose: the bundle is evaluated once per VU, and every MB of source
// costs ~2.7 MB of resident heap per VU on k6's engine (measured in #1126).
// An OCPP 1.6J station over ws:// does not reach the OCPP 2.0.1 / 2.1 schema
// registries (1.2 MB), X.509 / ASN.1 (0.5 MB), the SOAP XML parser (0.1 MB) or
// the Node `ws` client, so they are replaced by stubs that fail loudly if used.
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

/** Packages replaced by `stubs/lean.js`. */
const LEAN_PACKAGES = [
  "@peculiar/[^/]+",
  "asn1js",
  "@noble/[^/]+",
  "reflect-metadata",
  "tsyringe",
  "fast-xml-parser",
  "pvtsutils",
  "pvutils",
  "bytestreamjs",
];

const NODE_BUILTINS = new Set(
  (
    "assert buffer child_process crypto dns events fs http https module net os " +
    "path querystring readline stream tls url util worker_threads zlib"
  ).split(" "),
);

export interface BuiltEngine {
  /** The bundle, ES module text. */
  readonly code: string;
  /** What was stubbed, for the build log. */
  readonly stubbed: readonly string[];
}

export async function buildEngine(
  options: { minify?: boolean } = {},
): Promise<BuiltEngine> {
  const stubbed = new Set<string>();
  const leanRe = new RegExp(`^(${LEAN_PACKAGES.join("|")})(/|$)`);
  const plugin: Bun.BunPlugin = {
    name: "k6-host-lean",
    setup(build) {
      // OCPP 2.0.1 / 2.1 schema registries: an empty proxy.
      build.onLoad(
        { filter: /packages\/ocpp\/src\/(v201|v21)\/schemas\.ts$/ },
        (args) => {
          stubbed.add(relative(repoRoot, args.path));
          const name = args.path.includes("v201")
            ? "v201Schemas"
            : "v21Schemas";
          return {
            contents: `export const ${name} = new Proxy({}, { get: () => ({ definitions: {}, properties: {} }) });`,
            loader: "js",
          };
        },
      );
      build.onResolve({ filter: leanRe }, (args) => {
        stubbed.add(args.path);
        return { path: join(here, "stubs/lean.js") };
      });
      build.onResolve({ filter: /^ws$/ }, () => {
        stubbed.add("ws");
        return { path: join(here, "stubs/ws.js") };
      });
      build.onResolve({ filter: /^(node|bun):/ }, (args) => {
        stubbed.add(args.path);
        return { path: join(here, "stubs/node-empty.js") };
      });
      build.onResolve({ filter: /^[a-z_]+(\/.*)?$/ }, (args) => {
        if (!NODE_BUILTINS.has(args.path.split("/")[0]!)) return undefined;
        stubbed.add(`node:${args.path}`);
        return { path: join(here, "stubs/node-empty.js") };
      });
    },
  };
  const result = await Bun.build({
    entrypoints: [join(here, "../src/entry.ts")],
    target: "browser",
    format: "esm",
    minify: options.minify ?? true,
    external: ["k6", "k6/*"],
    plugins: [plugin],
    root: repoRoot,
  });
  if (!result.success) {
    throw new Error(
      `k6 engine build failed:\n${result.logs.map((l) => l.message).join("\n")}`,
    );
  }
  const output = result.outputs[0];
  if (!output) throw new Error("k6 engine build produced no output");
  return { code: await output.text(), stubbed: [...stubbed].sort() };
}

/**
 * {@link buildEngine} in a child `bun` process. Same result; used where the
 * bundler cannot run in-process: under `bun test`, `Bun.build` with
 * `target: "browser"` does not resolve extension-less relative imports (Bun
 * 1.3), while a plain `bun script.ts` does.
 */
export async function buildEngineInSubprocess(
  options: { minify?: boolean } = {},
): Promise<BuiltEngine> {
  const proc = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(import.meta.url),
      "--json",
      ...(options.minify === false ? ["--no-minify"] : []),
    ],
    { stdout: "pipe", stderr: "pipe", cwd: repoRoot },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0)
    throw new Error(`k6 engine build failed:\n${err}`);
  return JSON.parse(out) as BuiltEngine;
}

if (import.meta.main) {
  const minify = !process.argv.includes("--no-minify");
  const built = await buildEngine({ minify });
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(built));
  } else {
    const out = process.argv[2] ?? "engine.js";
    await Bun.write(out, built.code);
    console.log(`wrote ${out} (${(built.code.length / 1e6).toFixed(2)} MB)`);
    console.log(`stubbed: ${built.stubbed.join(", ")}`);
  }
}
