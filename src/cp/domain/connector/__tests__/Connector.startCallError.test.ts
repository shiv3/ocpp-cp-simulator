import { describe, expect, it } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import type { Transaction } from "../Transaction";

/**
 * #527: a CALLERROR answering the running transaction's StartTransaction.req
 * flags its `0` id as a placeholder the CSMS failed to process (#491). The
 * daemon persists the connector runtime on `transactionChange`, so the flag
 * must emit it rather than wait for the next status or meter change.
 */

function runningTransaction(): Transaction {
  return {
    id: 0,
    connectorId: 1,
    tagId: "TAG-527",
    meterStart: 0,
    meterStop: null,
    startTime: new Date("2026-10-30T00:00:00.000Z"),
    stopTime: null,
    meterSent: false,
  };
}

function connectorWithChanges() {
  const connector = new Connector(1, new Logger(LogLevel.ERROR));
  connector.beginTransaction(runningTransaction());
  const changes: Array<Transaction | null> = [];
  connector.events.on("transactionChange", ({ transaction }) =>
    changes.push(transaction),
  );
  return { connector, changes };
}

describe("Connector.markStartCallError (#527)", () => {
  it("flags the running transaction and emits transactionChange", () => {
    const { connector, changes } = connectorWithChanges();

    connector.markStartCallError();

    expect(connector.transaction?.startCallError).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.startCallError).toBe(true);
  });

  it("emits once for repeated CALLERRORs", () => {
    const { connector, changes } = connectorWithChanges();

    connector.markStartCallError();
    connector.markStartCallError();

    expect(changes).toHaveLength(1);
  });

  it("is a no-op without a transaction", () => {
    const connector = new Connector(1, new Logger(LogLevel.ERROR));
    const changes: unknown[] = [];
    connector.events.on("transactionChange", (e) => changes.push(e));

    connector.markStartCallError();

    expect(connector.transaction).toBeNull();
    expect(changes).toEqual([]);
  });
});
