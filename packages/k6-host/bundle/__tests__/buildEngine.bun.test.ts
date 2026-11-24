import { describe, expect, it } from "bun:test";
import { buildEngineInSubprocess as buildEngine } from "../buildEngine";

describe("k6 engine bundle (#1126)", () => {
  it("is one lean ES module that only imports k6 modules", async () => {
    const { code, stubbed } = await buildEngine();
    // The full bundle is ~3.8 MB; v2.x schemas, X.509, SOAP and `ws` are out.
    expect(code.length).toBeLessThan(1_300_000);
    expect(stubbed).toContain("ws");
    expect(stubbed).toContain("packages/ocpp/src/v201/schemas.ts");
    expect(stubbed).toContain("packages/ocpp/src/v21/schemas.ts");

    const imports = new Bun.Transpiler({ loader: "js" })
      .scanImports(code)
      .map((i) => i.path);
    // k6 resolves these itself; anything else would fail at k6's init.
    expect(imports.every((p) => p === "k6" || p.startsWith("k6/"))).toBe(true);
    expect(imports).toContain("k6/websockets");
    expect(code).not.toMatch(/node:(fs|path|net|http|crypto)/);
  });

  it("exports exactly what script.js imports", async () => {
    const { code } = await buildEngine({ minify: false });
    const exports = new Bun.Transpiler({ loader: "js" }).scan(code).exports;
    expect([...exports].sort()).toEqual([
      "k6Options",
      "readFleetConfig",
      "runVu",
    ]);
  });
});
