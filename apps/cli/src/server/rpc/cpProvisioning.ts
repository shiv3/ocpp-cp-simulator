import type { JsonObject } from "@ocpp-cp-simulator/contracts/behavior";
import {
  ARRAY_MAX_ITEMS,
  MAX_GENERATED_CP_ID_LENGTH,
  RpcFailure,
  createManyParamsSchema,
  createParamsSchema,
  expandIdPattern,
  labelsSchema,
  type Blueprint,
  type FleetTemplate,
  type Params,
  type Result,
} from "@ocpp-cp-simulator/contracts/index";
import type { CreateChargePointParams } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import {
  validateLayerConfig,
  type NetworkSimLayerConfig,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import { isSoapVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import { redactSensitiveText } from "@ocpp-cp-simulator/core/cp/shared/redaction";
import { getTemplateById } from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import {
  builtInBlueprints,
  isBuiltInBlueprint,
  MAX_STORED_BLUEPRINTS,
} from "@ocpp-cp-simulator/core/utils/blueprints/index";
import type { CLIChargePointService } from "../../service";
import { fleetTemplateNetworkSimulationError } from "../fleetTemplateFiles";
import { parseCreateBody } from "../httpServer";
import { SOAP_CHARGE_POINT_SERVICE_ROUTE } from "../../soapPath";
import { soapCallbackUrlSuffixWarning } from "../../soapCallbackUrl";
import type { RuntimeSocketIoDeps } from "../socketServer";
import { runFacadeOperation } from "./facadeErrors";

/**
 * Create exactly one charge point from an already-shaped params object.
 *
 * Split out of `createCp` so `cp.create_many` runs the identical path — the
 * SOAP callback warning, the facade error classification and the fire-and-
 * forget autoConnect included. A bulk-created charge point that behaved even
 * slightly differently from a singly-created one would be a trap.
 */
export async function createOneCp(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.create">,
): Promise<string> {
  const init = parseCreateInput(deps, params);
  if (isSoapVersion(init.ocppVersion) && init.soapCallbackUrl) {
    const suffixWarning = soapCallbackUrlSuffixWarning(init.soapCallbackUrl);
    if (suffixWarning) {
      process.stderr.write(`[server] Warning: ${suffixWarning}\n`);
    }
  }
  await runFacadeOperation(() =>
    deps.chargePointService.createChargePoint(
      init as unknown as CreateChargePointParams,
    ),
  );
  if (params.autoConnect === true) {
    void deps.chargePointService.connect(init.cpId).catch((err) => {
      process.stderr.write(
        `[server] autoConnect failed for ${init.cpId}: ${safeLogMessage(err)}\n`,
      );
    });
  }
  return init.cpId;
}

export async function createCp(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.create">,
): Promise<{ cpId: string }> {
  return { cpId: await createOneCp(deps, params) };
}

/**
 * `cp.create_many` — one call, N charge points sharing every parameter but the
 * generated id.
 *
 * Two behaviours worth naming because they are contracts, not incidentals:
 *
 * - **Partial success is the result.** A CSMS URL that only some ids can reach,
 *   or an id that collides with an existing charge point, must not discard the
 *   ones that came up. Failures are collected per id and returned; the call
 *   itself only fails when the parameters are unusable.
 * - **Creation is sequential.** Registry `event` pushes therefore arrive in id
 *   order, which a subscriber can rely on. Bulk creation is not on a hot path,
 *   so there is nothing to win by racing them.
 */
/**
 * Drop keys whose value is `undefined` so a spread cannot un-set a blueprint
 * field. `{ ...blueprint, ...requested }` with `requested.vendor === undefined`
 * would otherwise erase the blueprint's vendor.
 */
export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v;
  }
  return out as T;
}

export function saveBlueprint(
  deps: RuntimeSocketIoDeps,
  { blueprint }: Params<"blueprint.save">,
): { id: string } {
  if (isBuiltInBlueprint(blueprint.id)) {
    // Refused rather than shadowed: `blueprint.delete` cannot restore a
    // built-in, so an accidental overwrite would be permanent for that daemon.
    throw new RpcFailure(
      "invalid_params",
      `"${blueprint.id}" is a built-in blueprint and cannot be replaced; choose another id`,
    );
  }
  // Checked before the write: the list result carries the built-ins too, so an
  // unbounded store would make `blueprint.list` fail validation for everyone
  // rather than refuse the one save that crossed the line.
  const stored = deps.blueprints.list();
  if (
    stored.length >= MAX_STORED_BLUEPRINTS &&
    !stored.some((b) => b.id === blueprint.id)
  ) {
    throw new RpcFailure(
      "invalid_params",
      `at most ${MAX_STORED_BLUEPRINTS} blueprints can be stored; delete one first`,
    );
  }
  deps.blueprints.save(blueprint);
  return { id: blueprint.id };
}

export function deleteBlueprint(
  deps: RuntimeSocketIoDeps,
  { id }: Params<"blueprint.delete">,
): { ok: true } {
  if (isBuiltInBlueprint(id)) {
    throw new RpcFailure(
      "invalid_params",
      `"${id}" is a built-in blueprint and cannot be deleted`,
    );
  }
  // `not_found` rather than a silent success: a delete that reports ok for an
  // id that was never there hides a typo until the instantiate fails.
  if (!deps.blueprints.delete(id)) throw new RpcFailure("not_found", "");
  return { ok: true };
}

/**
 * Why one charge point in a batch could not be created, in a form safe to send
 * back over the control plane.
 *
 * `classifyFacadeError` deliberately blanks the message for the failures whose
 * text could carry a CSMS URL — an "already exists" collision among them — so
 * falling back to the error code is what keeps the row from being an empty
 * string. Terse, but paired with the `cpId` it is enough to act on, and it
 * leaks nothing. Anything else goes through the same redaction the log lines
 * use, since a create can fail on a URL carrying Basic Auth credentials.
 */
export function batchFailureReason(err: unknown): string {
  const reason =
    err instanceof RpcFailure ? err.message || err.code : safeLogMessage(err);
  // Bounded to the result schema's own limit. A failure whose message repeats a
  // long input — a 40 KB `tlsCaPath` that does not exist, say — would otherwise
  // make the *whole batch's* ack fail result validation and answer `internal`,
  // discarding the per-item report this method exists to give.
  return reason.length > MAX_FAILURE_REASON_LENGTH
    ? reason.slice(0, MAX_FAILURE_REASON_LENGTH - 1) + "\u2026"
    : reason;
}

/** Fits inside the result schema's `STR_64K`, with room for the ellipsis. */
const MAX_FAILURE_REASON_LENGTH = 2_000;

/** Bounds an expanded `soapCallbackUrl`; generous for a real URL. */
const MAX_SOAP_CALLBACK_URL_LENGTH = 2_048;

/**
 * The charge point id a callback URL's path would route to, or `null` if the
 * path is not a `ChargePointService` route at all. Uses the router's own
 * pattern and percent-decoding so this check and the router cannot disagree.
 */
export function soapCallbackRouteCpId(callbackUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(callbackUrl).pathname;
  } catch {
    return null;
  }
  const match = SOAP_CHARGE_POINT_SERVICE_ROUTE.exec(pathname);
  if (!match?.[2]) return null;
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

export async function createManyCps(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.create_many">,
): Promise<{
  created: string[];
  failed: Array<{ cpId: string; reason: string }>;
}> {
  // A blueprint supplies the parameter block; anything given alongside it
  // wins, so a fleet can share hardware and differ in one field. Resolved
  // before validation of the merged result, since the merge is what the
  // charge points are actually created from.
  const { blueprintId, ...requested } = params;
  let merged = requested;
  let defaults: Pick<Blueprint, "evSettings" | "scenarioTemplateId"> = {};
  if (blueprintId !== undefined) {
    const blueprint =
      builtInBlueprints().find((b) => b.id === blueprintId) ??
      deps.blueprints.get(blueprintId);
    if (!blueprint) {
      throw new RpcFailure("not_found", `no blueprint "${blueprintId}"`);
    }
    merged = { ...blueprint.params, ...stripUndefined(requested) };
    // A blueprint is more than its `cp.create` block: the schema also promises
    // default EV settings and a startup scenario. Copying only `params` left
    // both silently unapplied — including for every built-in, which is where
    // the EV settings are the whole point of picking a 150 kW profile.
    defaults = {
      evSettings: blueprint.evSettings,
      scenarioTemplateId: blueprint.scenarioTemplateId,
    };
  }
  // A blueprint batch may omit `idPattern`; derive one from the blueprint id so
  // `{ blueprintId, count }` is a complete call rather than a validation error.
  const withPattern =
    merged.idPattern === undefined && blueprintId !== undefined
      ? { ...merged, idPattern: `${blueprintId}-{n:03}` }
      : merged;
  const validated = createManyParamsSchema.safeParse(withPattern);
  if (!validated.success) {
    throw new RpcFailure(
      "invalid_params",
      validated.error.issues[0]?.message ?? "",
    );
  }
  const { count, idPattern, startIndex, ...shared } = validated.data;
  const first = startIndex ?? 1;

  const soapCallbackUrl = shared.soapCallbackUrl;

  // Expand every id first and check the batch as a whole. Creating as we go
  // and failing partway would leave charge points registered under ids the
  // result cannot even report — the schema caps the result strings — so the
  // parameters are rejected outright instead, before any side effect.
  const plan: Array<{ cpId: string; soapCallbackUrl?: string }> = [];
  for (let i = 0; i < count; i++) {
    const index = first + i;
    const cpId = expandIdPattern(idPattern, index);
    if (cpId.length > MAX_GENERATED_CP_ID_LENGTH) {
      // The pad-width cap does not bound this on its own: a pattern may repeat
      // the placeholder, and a few KB of input expands to a huge id.
      throw new RpcFailure(
        "invalid_params",
        `idPattern expands to a charge point id longer than ${MAX_GENERATED_CP_ID_LENGTH} characters`,
      );
    }
    if (!soapCallbackUrl) {
      plan.push({ cpId });
      continue;
    }
    // A SOAP charge point advertises the address the CSMS calls back on, and
    // the daemon routes those calls by the cpId embedded in it
    // (`<soapPath>/<cpId>/ChargePointService`). One URL shared across a batch
    // would point every station at the first station's route; so would a URL
    // whose placeholder is spelled differently from `idPattern`'s, e.g.
    // `SOAP{n}` against ids generated as `SOAP{n:03}` — the station registers
    // as SOAP001 while advertising SOAP1, and every inbound call 404s. Both
    // creates succeed either way, so the check has to be here.
    const expanded = expandIdPattern(soapCallbackUrl, index);
    // Bounded for the same reason the id is: a template repeating the
    // placeholder expands far past what any string limit allows, and this
    // value is retained and persisted per charge point.
    if (expanded.length > MAX_SOAP_CALLBACK_URL_LENGTH) {
      throw new RpcFailure(
        "invalid_params",
        `soapCallbackUrl expands to more than ${MAX_SOAP_CALLBACK_URL_LENGTH} characters`,
      );
    }
    if (soapCallbackRouteCpId(expanded) !== cpId) {
      // Checked through the router's own pattern and percent-decoding rather
      // than by substring: an id like "SITE A-1" is advertised as
      // "/SITE%20A-1/" and would fail a raw match, while
      // "/SITE A-1/extra/ChargePointService" would pass one and still 404.
      throw new RpcFailure(
        "invalid_params",
        `soapCallbackUrl must expand to a route whose charge point segment is "${cpId}" and which ends in /ChargePointService; the daemon routes inbound SOAP calls by that segment`,
      );
    }
    plan.push({ cpId, soapCallbackUrl: expanded });
  }

  const connectors = validated.data.connectors ?? 1;
  const created: string[] = [];
  const failed: Array<{ cpId: string; reason: string }> = [];
  for (const entry of plan) {
    try {
      const cpId = await createOneCp(deps, {
        ...shared,
        cpId: entry.cpId,
        ...(entry.soapCallbackUrl
          ? { soapCallbackUrl: entry.soapCallbackUrl }
          : {}),
      });
      try {
        await applyBlueprintDefaults(deps, cpId, connectors, defaults);
      } catch (err) {
        // Roll the charge point back. `createOneCp` has already registered and
        // persisted it, so reporting the id in `failed` while leaving it
        // behind would put a half-configured station in `cp.list` and make the
        // obvious retry fail with an already-exists error.
        await deps.chargePointService
          .removeChargePoint(cpId)
          .catch(() => undefined);
        throw err;
      }
      created.push(cpId);
    } catch (err) {
      failed.push({ cpId: entry.cpId, reason: batchFailureReason(err) });
    }
  }
  return { created, failed };
}

export function getFleetTemplate(
  deps: RuntimeSocketIoDeps,
  { id }: Params<"fleet.template.get">,
): FleetTemplate {
  const template = deps.fleetTemplates.get(id);
  if (!template) throw new RpcFailure("not_found", `no fleet template "${id}"`);
  return template;
}

export function saveFleetTemplate(
  deps: RuntimeSocketIoDeps,
  { template }: Params<"fleet.template.save">,
): { id: string } {
  if (deps.fleetTemplates.isProvided(template.id)) {
    // Refused rather than shadowed, like a built-in blueprint: the file wins at
    // every start, so a stored copy would be dead the next time the daemon runs.
    throw new RpcFailure(
      "invalid_params",
      `"${template.id}" comes from a --fleet-template file and cannot be replaced; choose another id`,
    );
  }
  const layerError = fleetTemplateNetworkSimulationError(template);
  if (layerError) throw new RpcFailure("invalid_params", layerError);
  // The list result carries the file templates too, so the ceiling is checked
  // against all of them before the write.
  const all = deps.fleetTemplates.list();
  if (all.length >= ARRAY_MAX_ITEMS && !all.some((t) => t.id === template.id)) {
    throw new RpcFailure(
      "invalid_params",
      `at most ${ARRAY_MAX_ITEMS} fleet templates can exist; delete one first`,
    );
  }
  deps.fleetTemplates.save(template);
  return { id: template.id };
}

export function deleteFleetTemplate(
  deps: RuntimeSocketIoDeps,
  { id }: Params<"fleet.template.delete">,
): { ok: true } {
  if (deps.fleetTemplates.isProvided(id)) {
    throw new RpcFailure(
      "invalid_params",
      `"${id}" comes from a --fleet-template file and cannot be deleted`,
    );
  }
  if (!deps.fleetTemplates.delete(id)) throw new RpcFailure("not_found", "");
  return { ok: true };
}

interface FleetPlanEntry {
  readonly cpId: string;
  readonly params: Params<"cp.create">;
  readonly connectors: number;
  readonly evSettings: Blueprint["evSettings"];
  readonly scenarioTemplateId: string | undefined;
  readonly networkSimulation: Record<string, unknown> | undefined;
  readonly autoConnect: boolean;
}

/**
 * Resolve a fleet template into the exact charge points it stands for, in
 * order, **before anything is created**: an unknown blueprint or scenario
 * template, an invalid merged parameter block, a repeated id or a bad label
 * set fails the whole call with `invalid_params` / `not_found` and no side
 * effect. What can only be known by trying — an id already registered, an
 * unreachable URL — is left to the per-charge-point report.
 *
 * Order is the template's own: groups in order, members in order, a range
 * ascending. `created` and `failed` therefore come back in the same order on
 * every call.
 */
function planFleet(
  deps: RuntimeSocketIoDeps,
  template: FleetTemplate,
  call: Params<"fleet.create">,
): FleetPlanEntry[] {
  const plan: FleetPlanEntry[] = [];
  const seen = new Set<string>();
  const prefix = call.idPrefix ?? "";
  for (const group of template.groups) {
    group.members.forEach((member, line) => {
      const where = `group "${group.name}", member ${line + 1}`;
      const blueprint =
        builtInBlueprints().find((b) => b.id === member.blueprintId) ??
        deps.blueprints.get(member.blueprintId);
      if (!blueprint) {
        throw new RpcFailure(
          "not_found",
          `no blueprint "${member.blueprintId}" (${where})`,
        );
      }
      const scenarioTemplateId =
        member.scenarioTemplateId ?? blueprint.scenarioTemplateId;
      if (scenarioTemplateId && !getTemplateById(scenarioTemplateId)) {
        throw new RpcFailure(
          "not_found",
          `no scenario template "${scenarioTemplateId}" (${where})`,
        );
      }
      if (member.networkSimulation !== undefined) {
        const layer = validateLayerConfig(member.networkSimulation);
        if (!layer.ok) {
          throw new RpcFailure(
            "invalid_params",
            `${where}: invalid networkSimulation: ${layer.errors[0] ?? "invalid layer config"}`,
          );
        }
      }
      const labels = labelsSchema.safeParse({
        ...blueprint.params.labels,
        ...template.labels,
        ...group.labels,
        ...member.labels,
      });
      if (!labels.success) {
        throw new RpcFailure(
          "invalid_params",
          `${where}: ${labels.error.issues[0]?.message ?? "invalid labels"}`,
        );
      }
      const count = member.count ?? 1;
      const first = member.startIndex ?? 1;
      for (let i = 0; i < count; i++) {
        const index = first + i;
        const cpId =
          prefix +
          (member.cpId !== undefined
            ? member.cpId
            : expandIdPattern(member.idPattern as string, index));
        if (cpId.length > MAX_GENERATED_CP_ID_LENGTH) {
          throw new RpcFailure(
            "invalid_params",
            `${where}: id longer than ${MAX_GENERATED_CP_ID_LENGTH} characters`,
          );
        }
        if (seen.has(cpId)) {
          throw new RpcFailure(
            "invalid_params",
            `charge point id "${cpId}" appears twice in the template (${where})`,
          );
        }
        seen.add(cpId);
        const merged: Record<string, unknown> = {
          ...blueprint.params,
          ...(call.wsUrl !== undefined ? { wsUrl: call.wsUrl } : {}),
          ...stripUndefined(member.overrides ?? {}),
          cpId,
          labels: labels.data,
        };
        // A SOAP callback is routed by the id inside it, so a range expands the
        // URL with the same index as its id and every result is checked, as in
        // cp.create_many.
        if (typeof merged.soapCallbackUrl === "string") {
          const url =
            member.idPattern !== undefined
              ? expandIdPattern(merged.soapCallbackUrl, index)
              : merged.soapCallbackUrl;
          if (soapCallbackRouteCpId(url) !== cpId) {
            throw new RpcFailure(
              "invalid_params",
              `${where}: soapCallbackUrl must expand to a route whose charge point segment is "${cpId}"`,
            );
          }
          if (url.length > MAX_SOAP_CALLBACK_URL_LENGTH) {
            throw new RpcFailure(
              "invalid_params",
              `${where}: soapCallbackUrl expands to more than ${MAX_SOAP_CALLBACK_URL_LENGTH} characters`,
            );
          }
          merged.soapCallbackUrl = url;
        }
        // Member override, then the call, then the blueprint, then off: the
        // caller's explicit choice beats what a blueprint saved.
        const autoConnect =
          member.overrides?.autoConnect ??
          call.autoConnect ??
          blueprint.params.autoConnect ??
          false;
        // Connecting waits until the EV settings, scenario and network
        // simulation are in place, so the CP never dials in a half-configured
        // state; creation itself must not connect.
        merged.autoConnect = false;
        const parsed = createParamsSchema.safeParse(merged);
        if (!parsed.success) {
          throw new RpcFailure(
            "invalid_params",
            `${cpId}: ${parsed.error.issues[0]?.message ?? "invalid parameters"}`,
          );
        }
        plan.push({
          cpId,
          params: parsed.data,
          connectors: parsed.data.connectors ?? 1,
          evSettings: member.evSettings ?? blueprint.evSettings,
          scenarioTemplateId,
          networkSimulation: member.networkSimulation,
          autoConnect,
        });
      }
    });
  }
  return plan;
}

/**
 * `fleet.create` (#445): instantiate a fleet template. Every charge point is
 * created through the same path as `cp.create_many` and is independent of the
 * template afterwards. Partial failure is the result: a charge point that
 * cannot be created, or configured after creation, is rolled back and reported
 * in `failed`; the rest stay.
 */
export async function createFleet(
  deps: RuntimeSocketIoDeps,
  params: Params<"fleet.create">,
): Promise<Result<"fleet.create">> {
  const template = deps.fleetTemplates.get(params.templateId);
  if (!template) {
    throw new RpcFailure(
      "not_found",
      `no fleet template "${params.templateId}"`,
    );
  }
  const plan = planFleet(deps, template, params);
  const created: string[] = [];
  const failed: Array<{ cpId: string; reason: string }> = [];
  for (const entry of plan) {
    try {
      const cpId = await createOneCp(deps, entry.params);
      try {
        await applyBlueprintDefaults(deps, cpId, entry.connectors, {
          evSettings: entry.evSettings,
          scenarioTemplateId: entry.scenarioTemplateId,
        });
        if (entry.networkSimulation) {
          await runFacadeOperation(() =>
            deps.chargePointService.saveNetworkSimCp(
              cpId,
              entry.networkSimulation as unknown as NetworkSimLayerConfig,
            ),
          );
        }
      } catch (err) {
        await deps.chargePointService
          .removeChargePoint(cpId)
          .catch(() => undefined);
        throw err;
      }
      created.push(cpId);
      if (entry.autoConnect) {
        void deps.chargePointService.connect(cpId).catch((err) => {
          process.stderr.write(
            `[server] autoConnect failed for ${cpId}: ${safeLogMessage(err)}\n`,
          );
        });
      }
    } catch (err) {
      failed.push({ cpId: entry.cpId, reason: batchFailureReason(err) });
    }
  }
  return { templateId: template.id, created, failed };
}

/**
 * Apply a blueprint's EV settings and startup scenario to a created charge
 * point, one connector at a time.
 *
 * A failure here fails the charge point: it is reported in `failed` rather
 * than left half-configured in `created`, since a station that came up with
 * generic EV settings while the caller asked for a 150 kW profile is the kind
 * of wrong that only shows up in the meter readings.
 */
async function applyBlueprintDefaults(
  deps: RuntimeSocketIoDeps,
  cpId: string,
  connectors: number,
  defaults: Pick<Blueprint, "evSettings" | "scenarioTemplateId">,
): Promise<void> {
  if (!defaults.evSettings && !defaults.scenarioTemplateId) return;
  for (let connectorId = 1; connectorId <= connectors; connectorId++) {
    if (defaults.evSettings) {
      await runFacadeOperation(() =>
        deps.chargePointService.setEVSettings(
          cpId,
          connectorId,
          defaults.evSettings as never,
        ),
      );
    }
    if (defaults.scenarioTemplateId) {
      await runFacadeOperation(() =>
        deps.chargePointService.loadScenarioTemplate(
          cpId,
          defaults.scenarioTemplateId as string,
          connectorId,
          // The blueprint's EV settings again, as the override: a template
          // carries its own and applies them when it starts, so without this
          // the scenario would quietly undo the settings applied above.
          defaults.evSettings as never,
        ),
      );
    }
  }
}

export async function updateCp(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.update">,
): Promise<{ cpId: string }> {
  const existing = deps.registry.get(params.cpId);
  if (!existing) throw new RpcFailure("not_found", "");
  const init = parseCreateInput(deps, mergeUpdateParams(params, existing));
  await runFacadeOperation(() =>
    deps.chargePointService.updateChargePoint(
      init as unknown as CreateChargePointParams,
    ),
  );
  if (params.autoConnect === true) {
    void deps.chargePointService.connect(init.cpId).catch((err) => {
      process.stderr.write(
        `[server] reconnect after update failed for ${init.cpId}: ${safeLogMessage(err)}\n`,
      );
    });
  }
  return { cpId: init.cpId };
}

/** #446: relabel in place — no rebuild, so the connection survives. */
export async function setCpLabels(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.labels.set">,
): Promise<{ cpId: string }> {
  await runFacadeOperation(() =>
    deps.chargePointService.setChargePointLabels(params.cpId, params.labels),
  );
  return { cpId: params.cpId };
}

/**
 * `cp.behaviors.set`: pick, by id, which loaded behaviors a charge point runs.
 * In place: no rebuild, the connection and any transaction stay. The ids are
 * looked up in the library `--behavior` filled at start; nothing in the
 * request is read as code.
 */
export async function setCpBehaviors(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.behaviors.set">,
): Promise<{ cpId: string; behaviors: string[] }> {
  const behaviors = await runFacadeOperation(() =>
    deps.registry.setBehaviors(
      params.cpId,
      params.behaviors ?? undefined,
      params.behaviorParams as Record<string, JsonObject> | undefined,
    ),
  );
  if (behaviors === null) throw new RpcFailure("not_found", "");
  return { cpId: params.cpId, behaviors };
}

/** The result schema holds 1000 entries; a large fleet can refuse more. */
const MAX_RELOAD_FAILURES = 1000;

function capFailures(failures: readonly string[]): string[] {
  const text = (m: string): string => m.slice(0, 60_000);
  if (failures.length <= MAX_RELOAD_FAILURES) return failures.map(text);
  return [
    ...failures.slice(0, MAX_RELOAD_FAILURES - 1).map(text),
    `... and ${failures.length - (MAX_RELOAD_FAILURES - 1)} more charge points kept the old version`,
  ];
}

/**
 * `behavior.reload`: re-read the files given at start. It takes no parameters,
 * so neither a path nor code can come from the caller.
 */
export async function reloadBehaviors(
  deps: RuntimeSocketIoDeps,
): Promise<Result<"behavior.reload">> {
  if (!deps.registry.library.rpcReloadAllowed) {
    throw new RpcFailure(
      "unavailable",
      "behavior.reload is off: start the daemon with --watch-behaviors or --allow-behavior-reload to let it re-read the --behavior files",
    );
  }
  const files = await deps.registry.library.reload();
  return {
    files: files.map((f) => ({
      file: f.file,
      ids: [...f.ids],
      ok: f.ok,
      unchanged: f.unchanged,
      ...(f.error === undefined ? {} : { error: f.error.slice(0, 60_000) }),
      applied: f.applied,
      failures: capFailures(f.failures),
    })),
  };
}

function parseCreateInput(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.create"> | Record<string, unknown>,
): ReturnType<typeof parseCreateBody> {
  try {
    return parseCreateBody(params, {
      soapCallbackUrlDerivable: deps.registry.canDeriveSoapCallbackUrl(),
    });
  } catch {
    throw new RpcFailure("invalid_params", "");
  }
}

function isRecord(rawParams: unknown): rawParams is Record<string, unknown> {
  return (
    rawParams !== null &&
    typeof rawParams === "object" &&
    !Array.isArray(rawParams)
  );
}

function mergeUpdateParams(
  params: Params<"cp.update">,
  existing: CLIChargePointService,
): Record<string, unknown> {
  const init = existing.getInit();
  const merged: Record<string, unknown> = { ...params };

  preserveWhenMissing(merged, "basicAuth", init.basicAuth);
  preserveWhenMissing(merged, "securityProfile", init.securityProfile);
  preserveWhenMissing(merged, "authorizationKey", init.authorizationKey);
  preserveWhenMissing(merged, "cpoName", init.cpoName);
  preserveWhenMissing(
    merged,
    "txUpdatedMeterValues",
    init.txUpdatedMeterValues,
  );
  preserveWhenMissing(merged, "inboundValidation", init.inboundValidation);
  preserveWhenMissing(
    merged,
    "reservationAuthorizeIdTag",
    init.reservationAuthorizeIdTag,
  );
  preserveWhenMissing(merged, "capabilityProfile", init.capabilityProfile);
  preserveWhenMissing(merged, "chargerCapabilities", init.chargerCapabilities);
  preserveWhenMissing(merged, "modem", init.modem);
  preserveWhenMissing(merged, "tlsCaPath", init.tlsCaPath);
  preserveWhenMissing(merged, "tlsCertPath", init.tlsCertPath);
  preserveWhenMissing(merged, "tlsKeyPath", init.tlsKeyPath);
  preserveWhenMissing(merged, "tls", init.tls);
  // `behaviors` and `behaviorParams` stay omitted: CPRegistry.update keeps
  // them (in memory and, for a run that holds fewer behaviors than the row
  // names, the stored columns as they are).

  if (isRecord(merged.basicAuth) && init.basicAuth) {
    const basicAuth = { ...merged.basicAuth };
    if (
      typeof basicAuth.password !== "string" ||
      basicAuth.password.length === 0
    ) {
      basicAuth.password = init.basicAuth.password;
    }
    if (typeof basicAuth.username !== "string") {
      basicAuth.username = init.basicAuth.username;
    }
    merged.basicAuth = basicAuth;
  }

  if (isRecord(merged.tls) && init.tls) {
    merged.tls = { ...init.tls, ...merged.tls };
  }

  return merged;
}

function preserveWhenMissing(
  params: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (
    value !== undefined &&
    !Object.prototype.hasOwnProperty.call(params, key)
  ) {
    params[key] = value;
  }
}

function safeLogMessage(err: unknown): string {
  if (!(err instanceof Error)) return "operation failed";
  return redactSensitiveText(
    err.message.replace(/\/\/[^@/\s]+@/g, "//[redacted]@"),
  );
}
