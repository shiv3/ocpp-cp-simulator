// Runs under `bun test`: startServer pulls in the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import type { ChargePointInitOptions } from "../../types";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { startServer, type RunningServer } from "../startServer";

/**
 * `--label` (#472) at the daemon boundary: the labels `parseArgs` puts on the
 * bootstrap reach every charge point of a `--cp-count` fleet, and `cp.list`
 * selects them — while a charge point restored from `--state-db` keeps the
 * labels it was stored with, like every other bootstrap option.
 */

const BASE_OPTIONS = {
  httpHost: "127.0.0.1",
  httpPort: 0,
  pidPath: null,
  soapPath: "/ocpp/soap",
  autoConnect: false,
  startupScenario: null,
  cors: { kind: "any" } as const,
  staticDir: null,
  webConsolePort: null,
  healthPath: "/v1/healthz",
  webConsoleBasicAuth: null,
  insecureTlsKeyPerms: false,
};

const BOOTSTRAP: ChargePointInitOptions = {
  cpId: "CP",
  wsUrl: "ws://127.0.0.1:1/ocpp",
  connectors: 1,
  vendor: "V",
  model: "M",
  basicAuth: null,
  labels: { site: "lab", env: "ci" },
};

interface CpSummary {
  cpId: string;
  labels?: Record<string, string>;
}

async function cpList(
  port: number,
  params: Record<string, unknown>,
): Promise<CpSummary[]> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "call_method",
        arguments: { method: "cp.list", params },
      },
    }),
  });
  const text = await res.text();
  const body = (res.headers.get("content-type") ?? "").includes(
    "application/json",
  )
    ? text
    : (text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6) ?? "");
  const response = JSON.parse(body) as {
    result?: { content?: Array<{ text?: string }> };
  };
  const toolText = response.result?.content?.[0]?.text;
  if (typeof toolText !== "string") {
    throw new Error(`No tool text in ${text}`);
  }
  return JSON.parse(toolText) as CpSummary[];
}

describe("startServer: --label on the bootstrapped fleet (#472)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  it("labels every charge point of a --cp-count fleet, and cp.list selects them", async () => {
    let running: RunningServer | null = null;
    running = await startServer({
      ...BASE_OPTIONS,
      stateDb: null,
      bootstrap: BOOTSTRAP,
      bootstrapCount: 3,
    });
    cleanups.push(() => running?.stop());
    const port = running.httpPort!;

    const selected = await cpList(port, { labels: { site: "lab" } });
    expect(selected.map((cp) => cp.cpId).sort()).toEqual([
      "CP001",
      "CP002",
      "CP003",
    ]);
    for (const cp of selected) {
      expect(cp.labels).toEqual({ site: "lab", env: "ci" });
    }
    // The selector really filters: another value selects none of them.
    expect(await cpList(port, { labels: { site: "other" } })).toEqual([]);
  });

  it("labels the single bootstrapped charge point without --cp-count", async () => {
    let running: RunningServer | null = null;
    running = await startServer({
      ...BASE_OPTIONS,
      stateDb: null,
      bootstrap: BOOTSTRAP,
    });
    cleanups.push(() => running?.stop());

    const selected = await cpList(running.httpPort!, {
      labels: { env: "ci" },
    });
    expect(selected.map((cp) => cp.cpId)).toEqual(["CP"]);
  });

  it("leaves a restored charge point's stored labels alone and labels only the new ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocpp-cp-sim-472-restore-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const stateDb = join(dir, "state.sqlite");
    {
      // A previous run created CP001, then an operator relabelled it.
      const db = BunSqliteDatabase.open(stateDb);
      const seed = new CPRegistry(new EventBus(), db, {});
      seed.create(
        { ...BOOTSTRAP, cpId: "CP001", labels: { site: "relabelled" } },
        { seedDefault: false },
      );
      seed.shutdownAll();
      db.close();
    }

    let running: RunningServer | null = null;
    running = await startServer({
      ...BASE_OPTIONS,
      stateDb,
      bootstrap: BOOTSTRAP,
      bootstrapCount: 2,
    });
    cleanups.push(() => running?.stop());
    const port = running.httpPort!;

    const all = await cpList(port, {});
    const labelsById = Object.fromEntries(
      all.map((cp) => [cp.cpId, cp.labels]),
    );
    expect(labelsById).toEqual({
      CP001: { site: "relabelled" },
      CP002: { site: "lab", env: "ci" },
    });
  });
});
