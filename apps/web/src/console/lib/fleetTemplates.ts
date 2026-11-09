import {
  fleetTemplateSchema,
  type FleetMember,
  type FleetTemplate,
} from "@ocpp-cp-simulator/contracts/methods";

/** How many charge points a member line stands for (a range counts `count`). */
export function memberCpCount(member: FleetMember): number {
  return member.count ?? 1;
}

/** Charge points the whole template stands for, ranges expanded. */
export function templateCpCount(template: FleetTemplate): number {
  return template.groups.reduce(
    (sum, group) =>
      sum + group.members.reduce((n, m) => n + memberCpCount(m), 0),
    0,
  );
}

/** What a member line names, e.g. `CP001` or `DC{n:03} × 2`. */
export function memberTarget(member: FleetMember): string {
  if (member.cpId !== undefined) return member.cpId;
  return `${member.idPattern ?? ""} × ${member.count ?? 1}`;
}

export type ParsedTemplate =
  { ok: true; template: FleetTemplate } | { ok: false; problems: string[] };

/**
 * Parse the text of the editor. It is the same JSON a `--fleet-template` file
 * holds, checked with the schema the daemon checks it with, so what the
 * console accepts is what `fleet.template.save` accepts.
 */
export function parseFleetTemplateJson(text: string): ParsedTemplate {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problems: [error instanceof Error ? error.message : String(error)],
    };
  }
  const parsed = fleetTemplateSchema.safeParse(value);
  if (parsed.success) return { ok: true, template: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    ),
  };
}

/** The text a new template starts from. */
export const NEW_TEMPLATE_JSON = JSON.stringify(
  {
    id: "my-fleet",
    name: "My fleet",
    groups: [
      {
        name: "site-a",
        members: [{ cpId: "CP001", blueprintId: "ac-22kw" }],
      },
    ],
  },
  null,
  2,
);
