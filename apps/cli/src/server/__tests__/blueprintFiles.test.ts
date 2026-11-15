import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { loadBlueprintFiles } from "../blueprintFiles";

const B = (id: string) => ({
  id,
  name: id,
  params: { connectors: 1, vendor: "Acme", model: "A1" },
});

function reader(files: Record<string, string>) {
  return (file: string) => {
    const content = files[file];
    if (content === undefined) throw new Error(`ENOENT: ${file}`);
    return content;
  };
}

describe("loadBlueprintFiles (#331)", () => {
  it("reads one blueprint or an array, across files, in order", () => {
    const read = reader({
      "a.json": JSON.stringify(B("a")),
      "b.json": JSON.stringify([B("b"), { ...B("c"), schemaVersion: 1 }]),
    });
    expect(
      loadBlueprintFiles(["a.json", "b.json"], read).map((b) => b.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("returns the file content as parsed, without adding a schemaVersion", () => {
    const [a] = loadBlueprintFiles(
      ["a.json"],
      reader({ "a.json": JSON.stringify(B("a")) }),
    );
    expect(a).toEqual(B("a"));
  });

  it("reads a real file from disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-file-"));
    try {
      const file = path.join(dir, "a.json");
      fs.writeFileSync(file, JSON.stringify(B("disk")));
      expect(loadBlueprintFiles([file]).map((b) => b.id)).toEqual(["disk"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the file and the path of a schema violation", () => {
    const bad = { ...B("a"), params: { connectors: 0 } };
    expect(() =>
      loadBlueprintFiles(["a.json"], reader({ "a.json": JSON.stringify(bad) })),
    ).toThrow(/^--blueprint a\.json: params\.connectors: /);
    expect(() =>
      loadBlueprintFiles(
        ["a.json"],
        reader({ "a.json": JSON.stringify([B("x"), { name: "n" }]) }),
      ),
    ).toThrow(/^--blueprint a\.json: 1\.id: /);
  });

  it("refuses a missing file, invalid JSON and a non-object", () => {
    expect(() => loadBlueprintFiles(["nope.json"], reader({}))).toThrow(
      /^--blueprint nope\.json: ENOENT/,
    );
    expect(() =>
      loadBlueprintFiles([path.join(os.tmpdir(), "does-not-exist-331.json")]),
    ).toThrow(/^--blueprint .*does-not-exist-331\.json: /);
    expect(() =>
      loadBlueprintFiles(["a.json"], reader({ "a.json": "{" })),
    ).toThrow(/^--blueprint a\.json: /);
    expect(() =>
      loadBlueprintFiles(["a.json"], reader({ "a.json": "42" })),
    ).toThrow(/^--blueprint a\.json: /);
  });

  it("says plainly that a newer schemaVersion is not supported", () => {
    expect(() =>
      loadBlueprintFiles(
        ["a.json"],
        reader({ "a.json": JSON.stringify({ ...B("a"), schemaVersion: 2 }) }),
      ),
    ).toThrow(
      "--blueprint a.json: schemaVersion 2 is not supported by this build (supports 1)",
    );
  });

  it("refuses an id defined twice and a built-in id", () => {
    expect(() =>
      loadBlueprintFiles(
        ["a.json", "b.json"],
        reader({
          "a.json": JSON.stringify(B("a")),
          "b.json": JSON.stringify(B("a")),
        }),
      ),
    ).toThrow(
      /--blueprint b\.json: blueprint id "a" is already defined by a\.json/,
    );
    expect(() =>
      loadBlueprintFiles(
        ["a.json"],
        reader({ "a.json": JSON.stringify(B("ac-22kw")) }),
      ),
    ).toThrow(/"ac-22kw" is a built-in blueprint id/);
  });
});
