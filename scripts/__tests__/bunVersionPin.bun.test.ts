import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// .tool-versions is the single source of the Bun version: mise and every
// workflow's setup-bun read it. The Docker image cannot (FROM needs a build
// arg), so its default is a copy that this guard keeps in step, and the
// workflows that build the image pass the value read from .tool-versions.
const REPO_ROOT = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

const toolVersionsBun = (): string | undefined =>
  read(".tool-versions")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([tool]) => tool === "bun")?.[1];

describe("Bun version pin", () => {
  it("defaults every Dockerfile BUN_VERSION ARG to the .tool-versions bun", () => {
    const pinned = toolVersionsBun() ?? "";
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);

    const defaults = [
      ...read("Dockerfile").matchAll(/^ARG BUN_VERSION=(\S+)/gm),
    ].map((m) => m[1]);
    expect(defaults.length).toBeGreaterThan(0);
    for (const value of defaults) expect(value).toBe(pinned);
  });

  it("passes BUN_VERSION read from .tool-versions to every workflow image build", () => {
    const workflows = readdirSync(join(REPO_ROOT, ".github/workflows"))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => read(join(".github/workflows", name)))
      .filter((text) => text.includes("docker/build-push-action@"));
    expect(workflows.length).toBeGreaterThan(0);
    for (const text of workflows) {
      const builds = text.split("docker/build-push-action@").slice(1);
      for (const build of builds) {
        // The step body, up to the next step or the comment above it.
        const step = build.split(/\n {6}[-#]/)[0];
        expect(step).toContain(
          "BUN_VERSION=${{ steps.bun-version.outputs.version }}",
        );
      }
      expect(text).toContain(`awk '$1=="bun"{print $2}' .tool-versions`);
    }
  });
});
