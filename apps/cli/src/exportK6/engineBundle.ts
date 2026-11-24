// apps/cli/src/exportK6/engineBundle.ts
// The k6 engine bundle `export-k6` writes as `engine.js`.
//
// Published CLI and sidecar: the bundle embedded at build time
// (`engine.generated.ts`, `bun run gen:k6-engine`). Run from sources, and
// whenever that file is missing: built on the fly from packages/k6-host, so a
// change to core is in the next export without a regeneration step.
import { isBun } from "../runtime";

/** True when this module runs from the repository's TypeScript sources. */
function runsFromSources(): boolean {
  return import.meta.url.endsWith(".ts");
}

export async function loadEngineBundle(): Promise<string> {
  if (runsFromSources() && isBun) {
    // A child process: `Bun.build` of the engine fails inside `bun test`.
    const { buildEngineInSubprocess } =
      await import("@ocpp-cp-simulator/k6-host/bundle/buildEngine");
    return (await buildEngineInSubprocess()).code;
  }
  try {
    const mod = await import("./engine.generated");
    return mod.ENGINE_BUNDLE;
  } catch {
    throw new Error(
      "this CLI build has no k6 engine embedded (run `bun run gen:k6-engine` before building it); " +
        "from a repository checkout, run the CLI with Bun (`bun apps/cli/src/main.ts export-k6 ...`)",
    );
  }
}
