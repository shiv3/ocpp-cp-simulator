import { expect, it } from "bun:test";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import { runMigrations } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/schema";
import { FakeCsms } from "@ocpp-cp-simulator/core/test/goldenWire/FakeCsms";
import { CPRegistry } from "../../server/CPRegistry";
import { EventBus } from "../../server/eventBus";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

it("A14 ctx.send in onResume reaches the CSMS on a daemon restart", async () => {
  const csms = new FakeCsms({ version: "1.6" });
  const url = csms.url;
  const db = BunSqliteDatabase.open(":memory:");
  runMigrations(db);
  const first = new CPRegistry(new EventBus(), db, { behaviors: [] });
  first.create(
    {
      cpId: "r1",
      wsUrl: url,
      connectors: 1,
      vendor: "v",
      model: "m",
      basicAuth: null,
    },
    { seedDefault: false },
  );
  first.shutdownAll();
  const errors: string[] = [];
  const b: Behavior = {
    api: 1,
    id: "resumes",
    onResume: async (ctx) => {
      try {
        await ctx.send("DataTransfer", { vendorId: "resumed" });
      } catch (e) {
        errors.push(String(e));
      }
    },
  };
  const next = new CPRegistry(new EventBus(), db, { behaviors: [b] });
  // What startServer does: restore, then (later) dial.
  const ids = next.restoreFromDatabase({ connect: false });
  await wait();
  next.connectRestored(ids);
  await wait(300);
  const sent = csms.frames.filter((f) => f.action === "DataTransfer");
  next.remove("r1");
  await csms.stop();
  expect(errors).toEqual([]);
  expect(sent.length).toBe(1);
});
