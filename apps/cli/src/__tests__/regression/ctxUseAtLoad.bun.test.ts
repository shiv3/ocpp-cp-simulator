// S3: a behavior that uses a physical verb or ctx.raw without listing the
// capability is refused when its file loads, not at the first call.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBehaviorFile } from "../../behavior/readBehaviorFile";
import { ctxCapabilityUses } from "../../behavior/ctxUse";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function file(source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctxuse-"));
  dirs.push(dir);
  const f = path.join(dir, "b.ts");
  writeFileSync(f, source);
  return f;
}
const mod = (requires: string, body: string): string => `
export default {
  api: 1,
  id: "b",
  ${requires}
  async main(ctx) {
    ${body}
  },
};
`;

describe("ctxCapabilityUses", () => {
  it("sees member access, element access and destructuring of ctx", () => {
    const uses = ctxCapabilityUses(
      'ctx.plugIn(1); ctx["raw"]("x"); const { startCharging } = ctx; other.unplug(); response.raw;',
    );
    expect([...uses.keys()].sort()).toEqual(["plugIn", "raw", "startCharging"]);
  });
});

describe("loading a behavior file", () => {
  it("refuses a physical verb without physical in requires", async () => {
    await expect(
      readBehaviorFile(file(mod("", "ctx.plugIn(1);"))),
    ).rejects.toThrow(/ctx\.plugIn needs "physical"/);
  });
  it("refuses ctx.raw without raw-frames", async () => {
    await expect(
      readBehaviorFile(file(mod("", 'ctx.raw("[2]");'))),
    ).rejects.toThrow(/ctx\.raw needs "raw-frames"/);
  });
  it("accepts them when the capability is listed", async () => {
    const r = await readBehaviorFile(
      file(
        mod(
          'requires: ["physical", "raw-frames"],',
          'ctx.plugIn(1); ctx.raw("[2]");',
        ),
      ),
    );
    expect(r.behaviors).toHaveLength(1);
  });
  it("does not mistake a property named raw on something else", async () => {
    const r = await readBehaviorFile(
      file(mod("", "const r = { raw: 1 }; ctx.log(String(r.raw));")),
    );
    expect(r.behaviors).toHaveLength(1);
  });
});
