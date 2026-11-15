import { z } from "zod";
import {
  ARRAY_1000,
  CP_CREATE_MANY_MAX,
  STR_256,
  STR_1K,
  STR_64K,
} from "../limits";
import { vehicleCatalogInfoSchema } from "../vehicle";
import { labelsSchema } from "../labels";
import { NON_EMPTY_STR, OBJ } from "./common";
import { ID_PATTERN_PLACEHOLDER, createManyParamsSchema } from "./cp";

/**
 * A named, reusable charge point description — the *hardware* half, where a
 * scenario is the *behaviour* half. The two compose: instantiate a blueprint,
 * then load a scenario onto a connector; neither needs to know about the other.
 *
 * `params` is the `cp.create` block minus `cpId`, which `cp.create_many`
 * generates. Derived from `createManyParamsSchema` rather than restated, and
 * without the batch fields — a blueprint says what a charge point *is*, not
 * how many of them to make.
 */
export const blueprintSchema = z.object({
  // `.min(1)`: an empty id would store a blueprint that `blueprint.delete`
  // refuses to accept, leaving it undeletable through the API.
  id: STR_256.min(1).describe("Blueprint identifier, unique within the daemon"),
  name: STR_256.min(1).describe("Human-readable name"),
  description: STR_1K.optional().describe("What this hardware profile is"),
  params: createManyParamsSchema
    .omit({ count: true, idPattern: true, startIndex: true })
    // `wsUrl` is optional here and required at instantiation. A blueprint
    // describes hardware; the CSMS a fleet points at is a property of the run,
    // which is why the built-in profiles carry no URL at all. `cp.create_many`
    // validates the merged result against `createManyParamsSchema`, so a
    // blueprint without one still cannot produce a charge point without one.
    .partial({ wsUrl: true })
    .describe("The cp.create parameter block, minus the generated cpId"),
  evSettings: OBJ()
    .optional()
    .describe("Default EV settings applied to every connector"),
  scenarioTemplateId: STR_256.optional().describe(
    "Scenario template loaded onto each connector after creation",
  ),
});

export type Blueprint = z.infer<typeof blueprintSchema>;

/** Most charge points one fleet template may stand for, ranges expanded. */
export const FLEET_TEMPLATE_MAX_CPS = 1_000;

/**
 * One line of a fleet template (#445): which charge point(s), made from which
 * blueprint, with which behaviour. Everything a line does not say comes from
 * the blueprint it names, so a blueprint or scenario definition is never
 * restated here — only referenced by id and, where one charge point must
 * differ, overridden field by field.
 *
 * A line names one charge point (`cpId`) or a numbered range (`idPattern` and
 * `count`, expanded like `cp.create_many`).
 */
export const fleetMemberSchema = z
  .object({
    cpId: NON_EMPTY_STR.optional().describe("One charge point's id"),
    idPattern: STR_64K.refine((v) => ID_PATTERN_PLACEHOLDER.test(v), {
      message:
        "idPattern must contain {n} or {n:0W} with W at most 2 digits, e.g. CP{n:03}",
    })
      .optional()
      .describe("Id template for a range, with count; {n} or {n:03}"),
    count: z
      .number()
      .int()
      .min(1)
      .max(CP_CREATE_MANY_MAX)
      .optional()
      .describe(`Range size (1..${CP_CREATE_MANY_MAX}), with idPattern`),
    startIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("First {n} of the range (default 1)"),
    blueprintId: STR_256.min(1).describe(
      "Blueprint (built-in or stored) this charge point is made from",
    ),
    scenarioTemplateId: STR_256.min(1)
      .optional()
      .describe(
        "Scenario template loaded onto every connector; replaces the blueprint's",
      ),
    evSettings: OBJ()
      .optional()
      .describe("EV settings for every connector; replace the blueprint's"),
    networkSimulation: OBJ()
      .optional()
      .describe(
        "Per-charge-point network simulation layer (as network_sim.cp.save), applied before the charge point connects",
      ),
    labels: labelsSchema.optional().describe("Labels added to this line"),
    overrides: blueprintSchema.shape.params
      .omit({ labels: true })
      .optional()
      .describe(
        "cp.create fields that replace the blueprint's for this line, e.g. vendor, model, connectors, ocppVersion, autoConnect",
      ),
  })
  .refine((m) => (m.cpId !== undefined) !== (m.idPattern !== undefined), {
    message: "a member needs exactly one of cpId or idPattern",
  })
  .refine((m) => (m.idPattern === undefined) === (m.count === undefined), {
    message: "idPattern and count go together",
  })
  .refine((m) => m.cpId === undefined || m.startIndex === undefined, {
    message: "startIndex belongs to a range, not to a single cpId",
  });
export type FleetMember = z.infer<typeof fleetMemberSchema>;

/** A named set of members that share labels, e.g. a site. */
export const fleetGroupSchema = z.object({
  name: STR_256.min(1).describe("Group name, unique within the template"),
  labels: labelsSchema
    .optional()
    .describe("Labels every member of the group gets"),
  members: ARRAY_1000(fleetMemberSchema).min(1),
});
export type FleetGroup = z.infer<typeof fleetGroupSchema>;

/**
 * A reusable description of a whole heterogeneous fleet (#445, decision D09):
 * the one shape both a template file (`--fleet-template`) and the state
 * database hold, so what `fleet.template.save` stores is what a file says.
 *
 * It composes blueprints and scenario templates by id and owns no hardware
 * or scenario definition of its own. `fleet.create` copies what it resolves
 * into independent charge points; editing a template afterwards never touches
 * a fleet that is already running.
 */
export const fleetTemplateSchema = z
  .object({
    id: STR_256.min(1).describe(
      "Template identifier, unique within the daemon",
    ),
    name: STR_256.min(1).describe("Human-readable name"),
    description: STR_1K.optional(),
    labels: labelsSchema
      .optional()
      .describe("Labels every charge point of the template gets"),
    groups: ARRAY_1000(fleetGroupSchema).min(1),
  })
  .refine(
    (t) => new Set(t.groups.map((g) => g.name)).size === t.groups.length,
    { message: "group names must be unique within a template" },
  )
  .refine(
    (t) =>
      t.groups.reduce(
        (sum, g) => sum + g.members.reduce((n, m) => n + (m.count ?? 1), 0),
        0,
      ) <= FLEET_TEMPLATE_MAX_CPS,
    {
      message: `a template may stand for at most ${FLEET_TEMPLATE_MAX_CPS} charge points`,
    },
  );
export type FleetTemplate = z.infer<typeof fleetTemplateSchema>;

/** `fleet.create` parameters. */
export const fleetCreateParamsSchema = z.object({
  templateId: STR_256.min(1).describe("Fleet template to instantiate"),
  wsUrl: z
    .union([STR_64K, ARRAY_1000(STR_64K).min(1)])
    .optional()
    .describe(
      "CSMS endpoint for every charge point whose line and blueprint name none. A line's overrides.wsUrl wins over this, this wins over the blueprint's",
    ),
  idPrefix: STR_64K.optional().describe(
    "Prepended to every charge point id, so one template can be instantiated more than once",
  ),
  autoConnect: z
    .boolean()
    .optional()
    .describe(
      "Connect each charge point once its EV settings, scenario and network simulation are in place; a line's overrides.autoConnect wins. Default false",
    ),
});
export type FleetCreateParams = z.infer<typeof fleetCreateParamsSchema>;

/** `fleet.create` result: partial success is the result, like `cp.create_many`. */
export const fleetCreateResultSchema = z.object({
  templateId: STR_256,
  created: ARRAY_1000(STR_64K),
  failed: ARRAY_1000(z.object({ cpId: STR_64K, reason: STR_64K })),
});
export type FleetCreateResult = z.infer<typeof fleetCreateResultSchema>;

export const serverInfoSchema = z.object({
  version: z.string(),
  soap: z.object({
    /** Origin the daemon derives SOAP callback URLs from; null when none. */
    publicBaseUrl: z.string().nullable(),
    /** The daemon's `--soap-path`. */
    path: z.string(),
    /** Set when the base comes from `--soap-tunnel`. */
    tunnel: z
      .object({
        provider: z.literal("ngrok"),
        mode: z.enum(["spawn", "attach"]),
      })
      .nullable(),
  }),
  /** #458: the vehicle catalog an import can read. Absent from older daemons. */
  vehicleCatalog: vehicleCatalogInfoSchema.optional(),
});
export type ServerInfo = z.infer<typeof serverInfoSchema>;

/**
 * The flattened shape for schema-driven clients (the MCP tool, `list_methods`).
 *
 * Every field with `wsUrl` optional, so `blueprintId` is visible rather than
 * hidden behind a union branch. `createManyFromBlueprintSchema` adds the
 * refinement that one of the two must be present.
 */
export const createManyToolSchema = createManyParamsSchema
  // `idPattern` joins `wsUrl` in being optional: `{ blueprintId, count }`
  // otherwise failed validation before the handler could default it.
  .partial({ wsUrl: true, idPattern: true })
  .extend({
    blueprintId: STR_256.min(1)
      .optional()
      .describe(
        "Blueprint to instantiate. Any parameter given alongside it overrides the blueprint's. Either this or wsUrl is required",
      ),
  });

/**
 * `cp.create_many` accepts either an explicit parameter block or a blueprint
 * id, so `wsUrl` cannot simply be required. A union rather than an
 * all-optional object: the latter would accept a call naming neither and fail
 * later, inside the loop, after some charge points already existed.
 */
/**
 * `cp.create_many` accepts either an explicit parameter block or a blueprint
 * id, so `wsUrl` cannot simply be required.
 *
 * One object with a refinement, **not** a union. A union's first matching
 * branch wins and unknown properties are stripped, so
 * `{ blueprintId, wsUrl, count, idPattern }` matched the explicit branch and
 * lost `blueprintId` silently — the batch came up with the caller's URL and
 * none of the blueprint's hardware, reporting success. The refinement keeps
 * every field and still refuses a call naming neither source, before anything
 * is created.
 */
export const createManyFromBlueprintSchema = createManyToolSchema.refine(
  (value) => value.wsUrl !== undefined || value.blueprintId !== undefined,
  { message: "either wsUrl or blueprintId is required" },
);
