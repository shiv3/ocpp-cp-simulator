// Runs under `bun test` because it uses the `bun:sqlite` built-in.
import { describe, expect, it } from "bun:test";

import { BunSqliteDatabase } from "../../persistence/BunSqliteDatabase";
import { makeChargePoint } from "./chargePointFixtures";

/**
 * #538: a NotifyEvent report queued offline survives a restart with
 * `--state-db`, so the next run's events must not reuse its eventIds:
 * the counter starts past the highest eventId still queued.
 */

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s eventId after a restart (#538)",
  (ocppVersion) => {
    it("numbers the new events past the ones still queued", () => {
      const db = BunSqliteDatabase.open(":memory:");
      const id = `CP-538-EID-${ocppVersion}`;
      try {
        const first = makeChargePoint({ id, ocppVersion, database: db });
        expect(
          first.configuration.applyChange("OfflineQueuingSeverity", "9"),
        ).toBe("Accepted");
        first.monitoring.install({
          type: "UpperThreshold",
          severity: 0,
          value: 400,
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
          valueKey: "HeartbeatInterval",
          valueType: { numeric: true },
        });
        expect(
          first.configuration.applyChange("HeartbeatInterval", "500"),
        ).toBe("Accepted");
        first.dispose();

        const second = makeChargePoint({ id, ocppVersion, database: db });
        try {
          expect(
            second.configuration.applyChange("HeartbeatInterval", "300"),
          ).toBe("Accepted");
        } finally {
          second.dispose();
        }

        const ids = db
          .all<{ payload: string }>(
            "SELECT payload FROM pending_messages WHERE cp_id = ? AND action = 'NotifyEvent' ORDER BY seq",
            [id],
          )
          .flatMap(
            (row) =>
              (JSON.parse(row.payload) as { eventData: { eventId: number }[] })
                .eventData,
          )
          .map((data) => data.eventId);
        expect(ids).toEqual([1, 2]);
      } finally {
        db.close();
      }
    });
  },
);
