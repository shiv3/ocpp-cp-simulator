import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { parseCreateBody } from "../httpServer";
import { RegistryChargePointService } from "../RegistryChargePointService";

const tempFiles: string[] = [];

afterEach(() => {
  while (tempFiles.length > 0) {
    const file = tempFiles.pop();
    if (file) fs.rmSync(file, { force: true });
  }
});

function writeTagFile(contents: string): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "idtags-")),
    "tags.json",
  );
  fs.writeFileSync(file, contents);
  tempFiles.push(file);
  return file;
}

const BASE = { cpId: "CP001", wsUrl: "ws://a/ocpp/", connectors: 2 };

describe("idTag pool parsing (#299)", () => {
  it("accepts inline tags", () => {
    const init = parseCreateBody({
      ...BASE,
      idTagPool: { tags: ["A", "B"], distribution: "connector-affinity" },
    });
    expect(init.idTags).toEqual(["A", "B"]);
    expect(init.idTagDistribution).toBe("connector-affinity");
  });

  it("resolves a file once, at creation", () => {
    // What is stored is the list, not the path: a file edited later must not
    // silently change a running charge point, and a bad path must fail the
    // create rather than the first transaction.
    const file = writeTagFile(JSON.stringify(["F1", "F2", "F3"]));
    const init = parseCreateBody({ ...BASE, idTagPool: { file } });
    expect(init.idTags).toEqual(["F1", "F2", "F3"]);

    fs.writeFileSync(file, JSON.stringify(["CHANGED"]));
    expect(init.idTags).toEqual(["F1", "F2", "F3"]);
  });

  it("fails the create for a missing or malformed file", () => {
    expect(() =>
      parseCreateBody({ ...BASE, idTagPool: { file: "/nope/missing.json" } }),
    ).toThrow(/could not be read/);

    const notJson = writeTagFile("nope");
    expect(() =>
      parseCreateBody({ ...BASE, idTagPool: { file: notJson } }),
    ).toThrow(/not valid JSON/);

    const wrongShape = writeTagFile(JSON.stringify({ tags: ["A"] }));
    expect(() =>
      parseCreateBody({ ...BASE, idTagPool: { file: wrongShape } }),
    ).toThrow(/array of non-empty strings/);

    const emptyEntry = writeTagFile(JSON.stringify(["A", ""]));
    expect(() =>
      parseCreateBody({ ...BASE, idTagPool: { file: emptyEntry } }),
    ).toThrow(/array of non-empty strings/);
  });

  it("refuses an unrecognised distribution rather than defaulting", () => {
    expect(() =>
      parseCreateBody({
        ...BASE,
        idTagPool: { tags: ["A"], distribution: "round_robin" },
      }),
    ).toThrow(/distribution must be/);
  });

  it("refuses an empty pool and a non-string entry", () => {
    expect(() =>
      parseCreateBody({ ...BASE, idTagPool: { tags: [] } }),
    ).toThrow();
    expect(() =>
      parseCreateBody({ ...BASE, idTagPool: { tags: ["A", 7] } }),
    ).toThrow(/non-empty strings/);
    expect(() => parseCreateBody({ ...BASE, idTagPool: {} })).toThrow();
  });

  it("leaves a charge point without a pool untouched", () => {
    const init = parseCreateBody(BASE);
    expect(init.idTags).toBeUndefined();
    expect(init.idTagDistribution).toBeUndefined();
  });
});

describe("idTag pool survives a restart (#299)", () => {
  it("persists the tags and the policy", () => {
    // Without this a charge point created with a pool came back drawing
    // nothing, silently falling back to the hard-coded literal.
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = new CPRegistry(new EventBus(), db);
      first.create(
        parseCreateBody({
          ...BASE,
          cpId: "CP-TAGS",
          idTagPool: { tags: ["R1", "R2"], distribution: "random" },
        }),
        { seedDefault: false },
      );
      first.shutdownAll();

      const second = new CPRegistry(new EventBus(), db);
      try {
        expect(second.restoreFromDatabase()).toContain("CP-TAGS");
        const init = second.get("CP-TAGS")?.getInit();
        expect(init?.idTags).toEqual(["R1", "R2"]);
        expect(init?.idTagDistribution).toBe("random");
      } finally {
        second.shutdownAll();
      }
    } finally {
      db.close();
    }
  });

  it("leaves a pool-less charge point exactly as it was", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = new CPRegistry(new EventBus(), db);
      first.create(parseCreateBody({ ...BASE, cpId: "CP-PLAIN" }), {
        seedDefault: false,
      });
      first.shutdownAll();

      const second = new CPRegistry(new EventBus(), db);
      try {
        second.restoreFromDatabase();
        expect(second.get("CP-PLAIN")?.getInit().idTags).toBeUndefined();
      } finally {
        second.shutdownAll();
      }
    } finally {
      db.close();
    }
  });
});

describe("the charge point draws from its pool (#299)", () => {
  it("fills a gap and never overrides an explicit tag", () => {
    const registry = new CPRegistry(new EventBus());
    try {
      const svc = registry.create(
        parseCreateBody({
          ...BASE,
          cpId: "CP-DRAW",
          idTagPool: { tags: ["P1", "P2"], distribution: "round-robin" },
        }),
        { seedDefault: false },
      );
      const cp = (
        svc as unknown as {
          _chargePoint: { nextIdTag(c?: number): string | null };
        }
      )._chargePoint;

      expect(cp.nextIdTag(1)).toBe("P1");
      expect(cp.nextIdTag(1)).toBe("P2");
      expect(cp.nextIdTag(1)).toBe("P1");
    } finally {
      registry.shutdownAll();
    }
  });

  it("returns null without a pool, so each call site keeps its own fallback", () => {
    const registry = new CPRegistry(new EventBus());
    try {
      const svc = registry.create(
        parseCreateBody({ ...BASE, cpId: "CP-NOPOOL" }),
        { seedDefault: false },
      );
      const cp = (
        svc as unknown as {
          _chargePoint: { nextIdTag(c?: number): string | null };
        }
      )._chargePoint;
      expect(cp.nextIdTag(1)).toBeNull();
    } finally {
      registry.shutdownAll();
    }
  });
});

describe("the pool survives the control-plane path (#299)", () => {
  it("reaches the charge point instead of being dropped by the facade", async () => {
    // The previous pool feature (#296) was inert for exactly this reason:
    // `parseCreateBody` produced the config, `toInitOptions` did not copy it,
    // and the create reported success with nothing wired up.
    const registry = new CPRegistry(new EventBus());
    const service = new RegistryChargePointService(registry);
    try {
      await service.createChargePoint(
        parseCreateBody({
          ...BASE,
          cpId: "CP-FACADE",
          idTagPool: { tags: ["F1", "F2"], distribution: "connector-affinity" },
        }),
      );
      const init = registry.get("CP-FACADE")?.getInit();
      expect(init?.idTags).toEqual(["F1", "F2"]);
      expect(init?.idTagDistribution).toBe("connector-affinity");
    } finally {
      registry.shutdownAll();
    }
  });

  it("clears the pool when an update omits it", async () => {
    const registry = new CPRegistry(new EventBus());
    const service = new RegistryChargePointService(registry);
    try {
      await service.createChargePoint(
        parseCreateBody({
          ...BASE,
          cpId: "CP-CLEARTAGS",
          idTagPool: { tags: ["F1"] },
        }),
      );
      await service.updateChargePoint(
        parseCreateBody({ ...BASE, cpId: "CP-CLEARTAGS" }),
      );
      expect(registry.get("CP-CLEARTAGS")?.getInit().idTags).toBeUndefined();
    } finally {
      registry.shutdownAll();
    }
  });
});

describe("a file cannot bypass the per-tag bound (#299)", () => {
  it("rejects a tag longer than the inline form allows", () => {
    const file = writeTagFile(JSON.stringify(["ok", "x".repeat(300)]));
    expect(() => parseCreateBody({ ...BASE, idTagPool: { file } })).toThrow(
      /longer than 256/,
    );
  });
});
