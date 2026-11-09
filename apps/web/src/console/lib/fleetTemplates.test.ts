import { describe, expect, it } from "vitest";

import {
  NEW_TEMPLATE_JSON,
  memberTarget,
  parseFleetTemplateJson,
  templateCpCount,
} from "./fleetTemplates";

describe("fleet template helpers (#445)", () => {
  it("starts a new template from one that is valid", () => {
    const parsed = parseFleetTemplateJson(NEW_TEMPLATE_JSON);
    expect(parsed.ok).toBe(true);
  });

  it("counts a range as its size and names a member by id or pattern", () => {
    const parsed = parseFleetTemplateJson(
      JSON.stringify({
        id: "t",
        name: "T",
        groups: [
          {
            name: "g",
            members: [
              { cpId: "A", blueprintId: "b" },
              { idPattern: "B{n}", count: 4, blueprintId: "b" },
            ],
          },
        ],
      }),
    );
    if (!parsed.ok) throw new Error(parsed.problems.join());
    expect(templateCpCount(parsed.template)).toBe(5);
    expect(parsed.template.groups[0]!.members.map(memberTarget)).toEqual([
      "A",
      "B{n} × 4",
    ]);
  });

  it("reports the path of each problem", () => {
    const parsed = parseFleetTemplateJson(
      JSON.stringify({
        id: "t",
        name: "T",
        groups: [{ name: "g", members: [{ cpId: "A" }] }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join("\n")).toContain(
      "groups.0.members.0.blueprintId",
    );
  });

  it("reports a rule of the whole template", () => {
    const parsed = parseFleetTemplateJson(
      JSON.stringify({
        id: "t",
        name: "T",
        groups: [
          { name: "g", members: [{ cpId: "A", blueprintId: "b" }] },
          { name: "g", members: [{ cpId: "B", blueprintId: "b" }] },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems).toContain(
      "group names must be unique within a template",
    );
  });
});
