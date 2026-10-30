// Runs under `bun test`: the SQLite implementation uses the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";

import type { ScenarioDefinition } from "../../../application/scenario/ScenarioTypes";
import { BunSqliteDatabase } from "../BunSqliteDatabase";
import {
  InMemoryScenarioRepository,
  type ScenarioRepository,
} from "../ScenarioRepository";
import { SqliteScenarioRepository } from "../SqliteScenarioRepository";

/**
 * #495: the scenario-definition contract, run against both stores a daemon
 * uses — the `scenarios` table with `--state-db`, the in-memory store
 * without — so the Library and the charge points' scenarios behave the same
 * either way.
 */

const LIBRARY = "__library__";

function scenario(
  id: string,
  updatedAt: string,
  overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
  return {
    id,
    name: id,
    enabled: true,
    updatedAt,
    nodes: [],
    edges: [],
    ...overrides,
  } as unknown as ScenarioDefinition;
}

const opened: BunSqliteDatabase[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

const implementations: Array<[string, () => ScenarioRepository]> = [
  ["in-memory", () => new InMemoryScenarioRepository()],
  [
    "sqlite",
    () => {
      const db = BunSqliteDatabase.open(":memory:");
      opened.push(db);
      return new SqliteScenarioRepository(db);
    },
  ],
];

describe.each(implementations)("ScenarioRepository (%s)", (_, create) => {
  it("reads back a Library scenario (connector null), newest first", async () => {
    const repo = create();
    const older = scenario("a", "2026-10-29T01:00:00.000Z");
    const newer = scenario("b", "2026-10-29T02:00:00.000Z");
    await repo.save(LIBRARY, null, older);
    await repo.save(LIBRARY, null, newer);

    expect(repo.listByConnector(LIBRARY, null)).toEqual([newer, older]);
    expect(await repo.load(LIBRARY, null)).toEqual(newer);
    expect(repo.listByConnector(LIBRARY, 1)).toEqual([]);
  });

  it("replaces a scenario saved again under the same id", async () => {
    const repo = create();
    await repo.save("CP1", 1, scenario("s", "2026-10-29T01:00:00.000Z"));
    const edited = scenario("s", "2026-10-29T02:00:00.000Z", {
      name: "edited",
    });
    await repo.save("CP1", 1, edited);

    expect(repo.listByConnector("CP1", 1)).toEqual([edited]);
  });

  it("replaces a connector's set and deletes one scenario", async () => {
    const repo = create();
    await repo.save("CP1", 1, scenario("old", "2026-10-29T01:00:00.000Z"));
    const kept = scenario("kept", "2026-10-29T02:00:00.000Z");
    const gone = scenario("gone", "2026-10-29T03:00:00.000Z");
    await repo.replaceConnector("CP1", 1, [kept, gone]);
    expect(repo.listByConnector("CP1", 1)).toEqual([gone, kept]);

    repo.deleteOne("CP1", 1, "gone");
    expect(repo.listByConnector("CP1", 1)).toEqual([kept]);
  });

  it("lists every connector of a charge point and keeps charge points apart", async () => {
    const repo = create();
    const c1 = scenario("c1", "2026-10-29T01:00:00.000Z");
    const c2 = scenario("c2", "2026-10-29T02:00:00.000Z");
    await repo.save("CP1", 1, c1);
    await repo.save("CP1", 2, c2);
    await repo.save("CP10", 1, scenario("other", "2026-10-29T03:00:00.000Z"));

    expect(await repo.list("CP1")).toEqual([c2, c1]);
  });

  it("tells subscribers about saves", async () => {
    const repo = create();
    const seen: Array<ScenarioDefinition | null> = [];
    const unsubscribe = repo.subscribe(LIBRARY, null, (s) => seen.push(s));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saved = scenario("s", "2026-10-29T01:00:00.000Z");
    await repo.save(LIBRARY, null, saved);
    unsubscribe();
    await repo.save(LIBRARY, null, scenario("t", "2026-10-29T02:00:00.000Z"));

    expect(seen).toEqual([null, saved]);
  });
});

describe("InMemoryScenarioRepository", () => {
  it("drops a deleted charge point's scenarios but keeps the Library", async () => {
    const repo = new InMemoryScenarioRepository();
    const library = scenario("lib", "2026-10-29T01:00:00.000Z");
    await repo.save(LIBRARY, null, library);
    await repo.save("CP1", 1, scenario("s", "2026-10-29T01:00:00.000Z"));
    await repo.save("CP1", null, scenario("cp", "2026-10-29T01:00:00.000Z"));

    repo.deleteForChargePoint("CP1");

    expect(await repo.list("CP1")).toEqual([]);
    expect(repo.listByConnector(LIBRARY, null)).toEqual([library]);
  });

  it("clears everything on state.reset", async () => {
    const repo = new InMemoryScenarioRepository();
    await repo.save(LIBRARY, null, scenario("lib", "2026-10-29T01:00:00.000Z"));
    await repo.save("CP1", 1, scenario("s", "2026-10-29T01:00:00.000Z"));

    repo.clear();

    expect(repo.listByConnector(LIBRARY, null)).toEqual([]);
    expect(await repo.list("CP1")).toEqual([]);
  });
});
