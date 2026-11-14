/**
 * Build the published CLI bundle, `dist-cli/main.js` (#916).
 *
 * One ES module bundle with a `node` shebang that runs on Node >= 22.13 AND on
 * Bun (the runtime layer in apps/cli/src/runtime/ picks the implementation at
 * start-up). `bun build --target=node` cannot produce it: it emits some
 * modules twice (BehaviorLibrary, CPRegistry, ...), so `instanceof` checks fail
 * and the daemon dies at start with `behaviors is not iterable`. rolldown (the
 * bundler vite already ships) keeps one copy of each module.
 *
 * The Docker image and the Tauri sidecar keep running on Bun with the previous
 * `bun build --target=bun` output: `bun run build:cli:bun`.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rolldown } from "rolldown";

const root = process.cwd();
const outDir = path.join(root, "dist-cli");
const outFile = path.join(outDir, "main.js");
const metafile = path.join(outDir, ".metafile.json");

/**
 * Bundled CommonJS code (typescript, ajv, ...) reads `require`, `__filename`
 * and `__dirname`, which an ES module does not have.
 */
const BANNER = [
  'import { createRequire as __ocppCreateRequire } from "node:module";',
  'import { fileURLToPath as __ocppFileURLToPath } from "node:url";',
  'import { dirname as __ocppDirname } from "node:path";',
  "const require = __ocppCreateRequire(import.meta.url);",
  "const __filename = __ocppFileURLToPath(import.meta.url);",
  "const __dirname = __ocppDirname(__filename);",
].join("\n");

const bundle = await rolldown({
  input: path.join(root, "apps/cli/src/main.ts"),
  platform: "node",
  logLevel: "warn",
  // The Node-only and Bun-only adapters are loaded through
  // process.getBuiltinModule / dynamic import at run time; nothing to leave out.
  transform: { target: "node22" },
});
const { output } = await bundle.generate({
  format: "es",
  codeSplitting: false,
  banner: BANNER,
  minify: false,
});
await bundle.close();

const chunk = output.find((o) => o.type === "chunk" && o.isEntry);
if (!chunk || chunk.type !== "chunk" || output.length !== 1) {
  throw new Error("build:cli: expected exactly one entry chunk");
}

mkdirSync(outDir, { recursive: true });
// main.ts carries its own `#!/usr/bin/env bun` (for `bun apps/cli/src/main.ts`);
// rolldown keeps it as the first line, so it is replaced, not stacked.
const code = chunk.code.replace(/^#![^\n]*\n/, "");
writeFileSync(outFile, `#!/usr/bin/env node\n${code}`);
chmodSync(outFile, 0o755);

// The third-party notices (#870) are listed from the same metafile shape
// `bun build --metafile` writes: the paths of the inlined inputs.
const inputs: Record<string, object> = {};
for (const id of Object.keys(chunk.modules)) {
  if (id.startsWith("\0")) continue;
  inputs[path.relative(root, id)] = {};
}
writeFileSync(metafile, JSON.stringify({ inputs }));
try {
  execFileSync(
    process.execPath,
    ["run", "scripts/generate-cli-notices.ts", metafile],
    { stdio: "inherit", cwd: root },
  );
} finally {
  rmSync(metafile, { force: true });
}
console.log(`build:cli: ${path.relative(root, outFile)}`);
