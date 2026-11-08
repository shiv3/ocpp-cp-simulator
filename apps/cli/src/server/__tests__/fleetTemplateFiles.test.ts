import { describe, expect, it } from "vitest";

import { loadFleetTemplateFiles } from "../fleetTemplateFiles";

const T = (id: string) => ({
  id,
  name: id,
  groups: [
    { name: "g", members: [{ cpId: `${id}-1`, blueprintId: "ac-22kw" }] },
  ],
});

function reader(files: Record<string, string>) {
  return (file: string) => {
    const content = files[file];
    if (content === undefined) throw new Error(`ENOENT: ${file}`);
    return content;
  };
}

describe("loadFleetTemplateFiles (#445)", () => {
  it("reads one template or an array, across files, in order", () => {
    const read = reader({
      "a.json": JSON.stringify(T("a")),
      "b.json": JSON.stringify([T("b"), T("c")]),
    });
    expect(
      loadFleetTemplateFiles(["a.json", "b.json"], read).map((t) => t.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("names the file and the path of a schema violation", () => {
    const bad = {
      ...T("a"),
      groups: [{ name: "g", members: [{ cpId: "x" }] }],
    };
    expect(() =>
      loadFleetTemplateFiles(
        ["a.json"],
        reader({ "a.json": JSON.stringify(bad) }),
      ),
    ).toThrow(/--fleet-template a\.json: groups\.0\.members\.0\.blueprintId/);
  });

  it("refuses unreadable files, bad JSON and an id defined twice", () => {
    expect(() => loadFleetTemplateFiles(["nope.json"], reader({}))).toThrow(
      /nope\.json/,
    );
    expect(() =>
      loadFleetTemplateFiles(["a.json"], reader({ "a.json": "{" })),
    ).toThrow(/a\.json/);
    expect(() =>
      loadFleetTemplateFiles(
        ["a.json", "b.json"],
        reader({
          "a.json": JSON.stringify(T("a")),
          "b.json": JSON.stringify(T("a")),
        }),
      ),
    ).toThrow(/already defined by a\.json/);
  });
});

describe("the shipped example (#445)", () => {
  it("is a valid fleet template that names real scenario templates", async () => {
    const { getTemplateById } =
      await import("@ocpp-cp-sim/core/utils/scenarioTemplates");
    const [lab] = loadFleetTemplateFiles([
      new URL(
        "../../../../../docs/examples/fleet-templates/operations-lab.json",
        import.meta.url,
      ).pathname,
    ]);
    expect(lab?.id).toBe("operations-lab");
    const refs = lab!.groups
      .flatMap((g) => g.members)
      .map((m) => m.scenarioTemplateId)
      .filter((id): id is string => id !== undefined);
    expect(refs.length).toBeGreaterThan(0);
    for (const id of refs) expect(getTemplateById(id)).toBeTruthy();
  });
});
