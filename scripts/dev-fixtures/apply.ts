#!/usr/bin/env bun
// Apply scripts/dev-fixtures/fixtures.json to a running simulator daemon.
//
//   SIM_USER=... SIM_PASS=... bun scripts/dev-fixtures/apply.ts \
//     --url http://127.0.0.1:9700 [--dry-run] [--verify] [--only <cpId>] [--prune]
//
// Idempotent: creates the charge points that are missing, fixes drift of the
// ones that exist, loads every template as a DISABLED scenario (stable id
// `<templateId>-c<connector>`, so `run_scenario_template` on demand replaces it
// in place) and keeps `essential-cp-behavior` as the only ENABLED scenario.
// Credentials come from SIM_USER / SIM_PASS only and are never printed.
import { io, type Socket } from "socket.io-client";
import {
  getTemplateById,
  scenarioTemplates,
} from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import fixturesJson from "./fixtures.json" with { type: "json" };

export const MANAGED_LABEL = { key: "managed-by", value: "dev-fixtures" };

export interface FixtureCp {
  cpId: string;
  role: string;
  connectors: number;
  chargerType: 1 | 11;
  maxPowerKw: number;
  vendor: string;
  model: string;
  labels: Record<string, string>;
  baseline: string;
  scenarios: Record<string, string[]>;
}
export interface Fixtures {
  csUrl: string;
  ocppVersion: string;
  cps: FixtureCp[];
}

// --- the daemon's rpc, paced and with readable errors -----------------------

// The daemon allows 100 rpc/s and 64 in flight per connection; stay well below.
const MAX_IN_FLIGHT = 8;
const MIN_GAP_MS = 20; // <= 50 calls/s
const RPC_TIMEOUT_MS = 35_000;

class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    message: string,
  ) {
    super(`${method}: ${code}: ${message}`);
  }
}

class Rpc {
  private inFlight = 0;
  private lastAt = 0;
  private waiters: Array<() => void> = [];
  readonly calls: Array<{ method: string; cpId?: string }> = [];
  constructor(private readonly socket: Socket) {}

  private async slot(): Promise<void> {
    while (this.inFlight >= MAX_IN_FLIGHT) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.inFlight++;
    const wait = this.lastAt + MIN_GAP_MS - Date.now();
    this.lastAt = Math.max(Date.now(), this.lastAt + MIN_GAP_MS);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    cpId?: string,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.slot();
      try {
        this.calls.push({ method, cpId });
        const ack = await new Promise<{
          ok: boolean;
          result?: T;
          error?: { code: string; message: string; retryAfterSeconds?: number };
        }>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new RpcError(method, "timeout", "no ack")),
            RPC_TIMEOUT_MS,
          );
          this.socket.emit(
            "rpc",
            cpId ? { cpId, method, params } : { method, params },
            (a: never) => {
              clearTimeout(timer);
              resolve(a);
            },
          );
        });
        if (ack.ok) return ack.result as T;
        const e = ack.error ?? { code: "internal", message: "no error body" };
        // The daemon's own bucket answers invalid_params with a "rate"-ish
        // message; upstream throttles answer rate_limited. Back off and retry
        // the former a few times, surface everything else as is.
        const looksRateLimited =
          e.code === "rate_limited" ||
          (e.code === "invalid_params" &&
            /rate|too many|bucket/i.test(e.message));
        if (looksRateLimited && attempt < 5) {
          const waitMs = (e.retryAfterSeconds ?? 1) * 1000 + attempt * 500;
          console.error(
            `  ! ${method} ${e.code} (${e.message}); retry in ${waitMs}ms`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new RpcError(method, e.code, e.message);
      } finally {
        this.inFlight--;
        this.waiters.shift()?.();
      }
    }
  }
}

// --- args ---------------------------------------------------------------------

interface Args {
  url: string;
  dryRun: boolean;
  verify: boolean;
  prune: boolean;
  only: string | null;
  fixtures: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    url: "",
    dryRun: false,
    verify: false,
    prune: false,
    only: null,
    fixtures: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) die(`${k} needs a value`);
      return v;
    };
    if (k === "--url") a.url = val();
    else if (k === "--only") a.only = val();
    else if (k === "--fixtures") a.fixtures = val();
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--verify") a.verify = true;
    else if (k === "--prune") a.prune = true;
    else if (k === "--help" || k === "-h") {
      console.log(
        "usage: SIM_USER=.. SIM_PASS=.. bun apply.ts --url <http://host:port> [--dry-run] [--verify] [--only <cpId>] [--prune] [--fixtures <file>]",
      );
      process.exit(0);
    } else die(`unknown flag ${k}`);
  }
  if (!a.url) die("--url is required");
  return a;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

// --- helpers --------------------------------------------------------------------

type Json = Record<string, unknown>;
interface CpListItem {
  cpId: string;
  status: string;
  wsUrl: string | string[];
  ocppVersion: string;
  connectors: number;
  vendor: string;
  model: string;
  labels?: Record<string, string>;
}
interface ScenarioRow {
  scenarioId: string;
  active: boolean;
}

const instanceId = (templateId: string, connector: number) =>
  `${templateId}-c${connector}`;
const sameLabels = (
  a: Record<string, string> = {},
  b: Record<string, string> = {},
) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return (
    ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
  );
};
const wsUrlOf = (fx: Fixtures, cp: FixtureCp) => fx.csUrl + cp.cpId;

/** The scenarios a connector must carry: template id -> expected `enabled`. */
function expectedScenarios(
  cp: FixtureCp,
  connector: number,
): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const t of cp.scenarios[String(connector)] ?? []) m.set(t, false);
  m.set(cp.baseline, true); // the only enabled one
  return m;
}

export function validateFixtures(fx: Fixtures): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  const known = new Set(scenarioTemplates.map((t) => t.id));
  for (const cp of fx.cps) {
    if (!/^shiv3-sc-[a-z0-9]+(-[a-z0-9]+)*$/.test(cp.cpId))
      errs.push(`bad cpId ${cp.cpId}`);
    if (seen.has(cp.cpId)) errs.push(`duplicate cpId ${cp.cpId}`);
    seen.add(cp.cpId);
    if (cp.labels[MANAGED_LABEL.key] !== MANAGED_LABEL.value)
      errs.push(
        `${cp.cpId}: missing label ${MANAGED_LABEL.key}=${MANAGED_LABEL.value}`,
      );
    if (!known.has(cp.baseline))
      errs.push(`${cp.cpId}: unknown baseline ${cp.baseline}`);
    for (const [conn, list] of Object.entries(cp.scenarios)) {
      const n = Number(conn);
      if (!Number.isInteger(n) || n < 1 || n > cp.connectors)
        errs.push(
          `${cp.cpId}: connector ${conn} out of range 1..${cp.connectors}`,
        );
      for (const t of list) {
        if (!known.has(t)) errs.push(`${cp.cpId}: unknown template ${t}`);
        if (t === cp.baseline)
          errs.push(
            `${cp.cpId}: baseline ${t} must not be listed in scenarios`,
          );
      }
    }
  }
  return errs;
}

// --- plan + apply ---------------------------------------------------------------

interface Ctx {
  rpc: Rpc;
  fx: Fixtures;
  args: Args;
  daemonTemplates: Set<string>;
  existing: Map<string, CpListItem>;
  failures: string[];
}

function act(ctx: Ctx, text: string): void {
  console.log(`${ctx.args.dryRun ? "[dry-run] would " : ""}${text}`);
}

async function listScenarios(
  ctx: Ctx,
  cpId: string,
  connector: number,
): Promise<ScenarioRow[]> {
  return ctx.rpc.call<ScenarioRow[]>("list_scenarios", { connector }, cpId);
}

async function loadScenario(
  ctx: Ctx,
  cp: FixtureCp,
  connector: number,
  templateId: string,
  enabled: boolean,
) {
  const template = getTemplateById(templateId);
  if (!template) throw new Error(`unknown template ${templateId}`);
  const definition = template.createScenario(
    cp.cpId,
    connector,
  ) as unknown as Json;
  definition.id = instanceId(templateId, connector);
  definition.enabled = enabled;
  await ctx.rpc.call(
    "load_scenario",
    { connector, scenario: definition },
    cp.cpId,
  );
}

async function syncCp(ctx: Ctx, cp: FixtureCp): Promise<void> {
  const { fx, rpc } = ctx;
  const want = {
    wsUrl: wsUrlOf(fx, cp),
    ocppVersion: fx.ocppVersion,
    connectors: cp.connectors,
    vendor: cp.vendor,
    model: cp.model,
    labels: cp.labels,
  };
  const have = ctx.existing.get(cp.cpId);
  let justCreated = false;

  if (!have) {
    act(
      ctx,
      `create ${cp.cpId} (${cp.connectors} connectors, ${want.wsUrl}) with labels ${JSON.stringify(cp.labels)}`,
    );
    if (!ctx.args.dryRun) {
      // autoConnect stays off: the disabled scenarios must be in place before
      // the first connect, and the baseline is (re)loaded enabled below.
      await rpc.call("cp.create", {
        cpId: cp.cpId,
        ...want,
        autoConnect: false,
      });
      justCreated = true;
    }
  } else {
    const hasLabel = have.labels?.[MANAGED_LABEL.key] === MANAGED_LABEL.value;
    const urlNow = Array.isArray(have.wsUrl)
      ? have.wsUrl.join(",")
      : have.wsUrl;
    const hwDrift =
      urlNow !== want.wsUrl ||
      have.ocppVersion !== want.ocppVersion ||
      have.connectors !== want.connectors ||
      have.vendor !== want.vendor ||
      have.model !== want.model;
    if (!hasLabel && !sameLabels(have.labels, {})) {
      // Someone else's CP under a fixture id: do not touch it.
      ctx.failures.push(
        `${cp.cpId}: exists with other labels and without ${MANAGED_LABEL.key}=${MANAGED_LABEL.value}; skipped`,
      );
      console.error(
        `! ${cp.cpId} exists but is not managed by dev-fixtures; skipped`,
      );
      return;
    }
    if (hwDrift) {
      act(
        ctx,
        `update ${cp.cpId} (drift: ${JSON.stringify({ wsUrl: urlNow, connectors: have.connectors, vendor: have.vendor, model: have.model, ocppVersion: have.ocppVersion })} -> ${JSON.stringify({ ...want, labels: undefined })}); scenarios are kept`,
      );
      if (!ctx.args.dryRun)
        await rpc.call("cp.update", {
          cpId: cp.cpId,
          ...want,
          autoConnect: true,
        });
    } else if (!sameLabels(have.labels, cp.labels)) {
      act(
        ctx,
        `relabel ${cp.cpId} ${JSON.stringify(have.labels ?? {})} -> ${JSON.stringify(cp.labels)}`,
      );
      if (!ctx.args.dryRun)
        await rpc.call("cp.labels.set", { cpId: cp.cpId, labels: cp.labels });
    } else {
      console.log(`ok    ${cp.cpId} exists (${have.connectors} connectors)`);
    }
  }

  const cpExists = !!have || justCreated;
  for (let connector = 1; connector <= cp.connectors; connector++) {
    const want = expectedScenarios(cp, connector);
    const rows = cpExists ? await listScenarios(ctx, cp.cpId, connector) : [];
    const byId = new Map(rows.map((r) => [r.scenarioId, r]));
    // Disabled templates first, baseline last (so nothing auto-starts before the
    // CP is meant to run it; the baseline is only armed on connect).
    const order = [...want.entries()].sort(
      (a, b) => Number(a[1]) - Number(b[1]),
    );
    for (const [templateId, enabled] of order) {
      const id = instanceId(templateId, connector);
      let needs = !byId.has(id);
      let why = "missing";
      if (!needs && cpExists) {
        const def = await ctx.rpc.call<{
          enabled?: boolean;
          templateId?: string;
        }>("get_scenario", { connector, scenarioId: id }, cp.cpId);
        if ((def.enabled ?? true) !== enabled) {
          needs = true;
          why = `enabled=${def.enabled ?? true}, want ${enabled}`;
        }
      }
      if (!needs) continue;
      if (byId.get(id)?.active) {
        // Re-loading would discard the run someone is watching; leave it.
        console.error(
          `! ${id} on ${cp.cpId} c${connector} is running (${why}); not touched, re-run apply when it ended`,
        );
        continue;
      }
      if (!ctx.daemonTemplates.has(templateId)) {
        const msg = `${cp.cpId} c${connector}: the daemon does not know template ${templateId} (older daemon?); not loaded`;
        ctx.failures.push(msg);
        console.error(`! ${msg}`);
        continue;
      }
      act(
        ctx,
        `load ${id} on ${cp.cpId} c${connector} enabled=${enabled} (${why})`,
      );
      if (!ctx.args.dryRun) {
        await loadScenario(ctx, cp, connector, templateId, enabled);
      }
    }
    // A fixture-managed connector must not carry other ENABLED scenarios
    // (e.g. a template someone ran on demand with the default re-arm).
    for (const r of rows) {
      const tid = r.scenarioId.replace(/-c\d+$/, "");
      if (want.has(tid)) continue;
      if (!getTemplateById(tid)) continue; // user-authored: leave alone
      const def = await ctx.rpc.call<{ enabled?: boolean }>(
        "get_scenario",
        { connector, scenarioId: r.scenarioId },
        cp.cpId,
      );
      if (def.enabled !== false && !r.active) {
        act(ctx, `disable stray ${r.scenarioId} on ${cp.cpId} c${connector}`);
        if (!ctx.args.dryRun)
          await loadScenario(ctx, cp, connector, tid, false);
      }
    }
  }

  // Connect last (a no-op for a CP that is up). `connect` resolves on socket
  // open and rejects on the first close: a refusal is reported, the daemon's
  // reconnect loop keeps trying.
  const current = justCreated ? "new" : have?.status;
  if (justCreated || (have && !isConnectedStatus(current ?? ""))) {
    act(ctx, `connect ${cp.cpId}`);
    if (!ctx.args.dryRun) {
      try {
        await rpc.call("connect", {}, cp.cpId);
      } catch (e) {
        const msg = `${cp.cpId}: connect failed: ${(e as Error).message}`;
        ctx.failures.push(msg);
        console.error(`! ${msg}`);
      }
    }
  }
}

/** cp.list `status` is the CP-level OCPP status: Available once the CSMS accepted the boot. */
function isConnectedStatus(status: string): boolean {
  return (
    !["Unavailable", "Disconnected", "Connecting", "Faulted", ""].includes(
      status,
    ) && status !== "new"
  );
}

async function verify(ctx: Ctx, cps: FixtureCp[]): Promise<number> {
  let bad = 0;
  const fail = (m: string) => {
    bad++;
    console.error(`FAIL  ${m}`);
  };
  const list = await ctx.rpc.call<CpListItem[]>("cp.list", {});
  const byId = new Map(list.map((c) => [c.cpId, c]));
  let scenarios = 0;
  for (const cp of cps) {
    const have = byId.get(cp.cpId);
    if (!have) {
      fail(`${cp.cpId}: not registered`);
      continue;
    }
    if (have.labels?.[MANAGED_LABEL.key] !== MANAGED_LABEL.value)
      fail(`${cp.cpId}: missing managed-by label`);
    if (have.connectors !== cp.connectors)
      fail(`${cp.cpId}: ${have.connectors} connectors, want ${cp.connectors}`);
    if (have.vendor !== cp.vendor || have.model !== cp.model)
      fail(`${cp.cpId}: vendor/model ${have.vendor}/${have.model}`);
    // Boot accepted: wait briefly for a CP that was just connected.
    let status = have.status;
    for (let i = 0; i < 20 && !isConnectedStatus(status); i++) {
      await new Promise((r) => setTimeout(r, 500));
      const st = await ctx.rpc.call<{ status: string }>("status", {}, cp.cpId);
      status = st.status;
    }
    if (!isConnectedStatus(status))
      fail(`${cp.cpId}: not connected / boot not accepted (status ${status})`);
    for (let connector = 1; connector <= cp.connectors; connector++) {
      const rows = await listScenarios(ctx, cp.cpId, connector);
      const ids = new Set(rows.map((r) => r.scenarioId));
      for (const [templateId, enabled] of expectedScenarios(cp, connector)) {
        const id = instanceId(templateId, connector);
        if (!ids.has(id)) {
          fail(`${cp.cpId} c${connector}: scenario ${id} missing`);
          continue;
        }
        const def = await ctx.rpc.call<{ enabled?: boolean }>(
          "get_scenario",
          { connector, scenarioId: id },
          cp.cpId,
        );
        scenarios++;
        if ((def.enabled ?? true) !== enabled)
          fail(
            `${cp.cpId} c${connector}: ${id} enabled=${def.enabled ?? true}, want ${enabled}`,
          );
        const row = rows.find((r) => r.scenarioId === id)!;
        if (!enabled && row.active)
          fail(`${cp.cpId} c${connector}: ${id} is running but should be idle`);
      }
    }
  }
  console.log(
    `verify: ${cps.length} CPs, ${scenarios} scenarios checked, ${bad} problem(s)`,
  );
  return bad;
}

async function prune(ctx: Ctx, wanted: Set<string>): Promise<void> {
  for (const [cpId, cp] of ctx.existing) {
    if (cp.labels?.[MANAGED_LABEL.key] !== MANAGED_LABEL.value) continue; // never touch others (shiv3-cp7!)
    if (wanted.has(cpId)) continue;
    if (!/^shiv3-sc-/.test(cpId)) {
      console.error(
        `! refusing to prune ${cpId}: label is set but the id is not shiv3-sc-*`,
      );
      continue;
    }
    act(
      ctx,
      `prune ${cpId} (labelled ${MANAGED_LABEL.key}=${MANAGED_LABEL.value}, not in fixtures)`,
    );
    if (!ctx.args.dryRun)
      await ctx.rpc.call("cp.delete", { cpId, stopTransactions: false });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const user = process.env.SIM_USER ?? "";
  const pass = process.env.SIM_PASS ?? "";
  const fx: Fixtures = args.fixtures
    ? JSON.parse(await Bun.file(args.fixtures).text())
    : (fixturesJson as unknown as Fixtures);

  const problems = validateFixtures(fx);
  if (problems.length) die(`fixtures invalid:\n  ${problems.join("\n  ")}`);
  if (args.only && !fx.cps.some((c) => c.cpId === args.only))
    die(`--only ${args.only}: not in fixtures`);
  const targets = fx.cps.filter((c) => !args.only || c.cpId === args.only);

  const base = args.url.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (user || pass)
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  const socket = io(base, {
    path: "/socket.io/",
    transports: ["websocket"],
    auth: user || pass ? { username: user, password: pass } : undefined,
    extraHeaders: headers,
    reconnection: false,
    timeout: 10_000,
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", (e) =>
      reject(
        new Error(
          `cannot connect to ${base}: ${e.message}${/unauthorized/i.test(e.message) ? " (check SIM_USER / SIM_PASS)" : ""}`,
        ),
      ),
    );
  }).catch((e) => die((e as Error).message));

  const rpc = new Rpc(socket);
  try {
    const info = await rpc.call<{ version?: string }>("server.info", {});
    console.log(
      `daemon ${base} version ${info.version ?? "?"}; ${targets.length}/${fx.cps.length} fixture CPs${args.dryRun ? " (dry-run)" : ""}`,
    );
    const tpl = await rpc.call<Array<{ id: string }>>("scenario.templates", {});
    const list = await rpc.call<CpListItem[]>("cp.list", {});
    const ctx: Ctx = {
      rpc,
      fx,
      args,
      daemonTemplates: new Set(tpl.map((t) => t.id)),
      existing: new Map(list.map((c) => [c.cpId, c])),
      failures: [],
    };

    for (const cp of fx.cps) {
      if (
        cp.cpId === "shiv3-cp7" ||
        /^shiv3-cp/.test(cp.cpId) ||
        /^79\d{4}$/.test(cp.cpId)
      )
        die(`${cp.cpId} is reserved`);
    }

    if (args.verify) {
      const bad = await verify(ctx, targets);
      process.exitCode = bad ? 1 : 0;
      return;
    }

    for (const cp of targets) await syncCp(ctx, cp);
    if (args.prune) await prune(ctx, new Set(fx.cps.map((c) => c.cpId)));

    if (ctx.failures.length) {
      console.error(
        `\n${ctx.failures.length} problem(s):\n  ${ctx.failures.join("\n  ")}`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        args.dryRun ? "\ndry-run done: nothing was changed" : "\napply done",
      );
    }
    if (!args.dryRun) console.log(`rpc calls: ${rpc.calls.length}`);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
}

if (import.meta.main) await main();
