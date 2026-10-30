// Runs under `bun test` because it uses the `bun:sqlite` built-in.
import { describe, expect, it, spyOn } from "bun:test";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import type { ChargePoint } from "../../../cp/domain/charge-point/ChargePoint";
import { testCpInit } from "../../__tests__/testCpInit";

/**
 * #538: since the periodic monitors keep their timers offline (N08.FR.03),
 * a `cp.update` must stop them on the instance it replaces. Left running,
 * the discarded instance would keep its whole graph alive and queue
 * `pending_messages` rows, under the same `cp_id`, that the new instance
 * never sees until the next restart.
 */

interface EvaluationInternals {
  disposed: boolean;
  periodic: { timers: Map<number, unknown> };
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s periodic monitors across cp.update (#538)",
  (ocppVersion) => {
    it("stops the replaced instance's timers, so it queues nothing more", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      const registry = new CPRegistry(new EventBus(), db);
      const init = testCpInit({
        cpId: `CP-538-UPD-${ocppVersion}`,
        ocppVersion,
      });
      try {
        registry.create(init, { seedDefault: false });
        const old = registry.get(init.cpId)!["_chargePoint"] as ChargePoint;
        expect(
          old.configuration.applyChange("OfflineQueuingSeverity", "9"),
        ).toBe("Accepted");
        const installed = old.monitoring.install({
          type: "Periodic",
          severity: 0,
          value: 1,
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
          valueKey: "HeartbeatInterval",
          valueType: { numeric: true },
        });
        expect(installed.status).toBe("Accepted");
        const evaluation = old[
          "_monitorEvaluation"
        ] as unknown as EvaluationInternals;
        expect(evaluation.periodic.timers.size).toBe(1);
        const queued = spyOn(old["_messageHandler"], "queueNotifyEvent");

        registry.update(init);

        expect(evaluation.disposed).toBe(true);
        expect(evaluation.periodic.timers.size).toBe(0);
        await Bun.sleep(1_300);
        expect(queued).not.toHaveBeenCalled();
      } finally {
        registry.remove(init.cpId);
        db.close();
      }
    });
  },
);
