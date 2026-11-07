// `patchTransaction` "does the same for a Transaction that may be detached", but
// `Object.assign` on a detached view goes through the Proxy `set` trap into the
// store: the write is lost (no transaction) or lands on the NEXT transaction.
// Passes on ca01d302, fails on 30b57145.
import { expect, test } from "bun:test";
import { Rig } from "../goldenWire/rig";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";

test("2.x: a transaction stopped during the Preparing write still has a Started frame with an id", async () => {
  const rig = await Rig.create({ version: "2.0.1" });
  try {
    let done = false;
    rig.cp.events.on("connectorStatusChange", (e: { status: string }) => {
      if (e.status === OCPPStatus.Preparing && !done) {
        done = true;
        rig.cp.stopTransaction(1, "Other");
      }
    });
    await rig.cp.startTransaction("TAG", 1);
    await rig.csms.settle();
    const events = rig.csms.frames
      .filter((f) => f.dir === "CP>" && f.action === "TransactionEvent")
      .map(
        (f) =>
          f.payload as {
            eventType: string;
            transactionInfo: { transactionId?: string };
          },
      );
    const started = events.find((e) => e.eventType === "Started");
    expect(started).toBeDefined();
    // transactionId is required by the 2.0.1 schema.
    expect(typeof started!.transactionInfo.transactionId).toBe("string");
  } finally {
    await rig.dispose();
  }
});

test("a write through a detached view does not land on the next transaction", async () => {
  const rig = await Rig.create({ version: "1.6" });
  try {
    const connector = rig.cp.getConnector(1)!;
    await rig.cp.startTransaction("OLD", 1);
    await rig.csms.settle();
    const stale = connector.transaction!;
    rig.cp.stopTransaction(1);
    await rig.csms.settle();
    await rig.cp.startTransaction("NEW", 1);
    await rig.csms.settle();
    const fresh = connector.transaction!;
    const idBefore = fresh.id;
    // What the fallback branch of handlers/patchTransaction.ts does.
    Object.assign(stale, { id: 999, tagId: "STALE" });
    expect(connector.transaction!.tagId).toBe("NEW");
    expect(connector.transaction!.id).toBe(idBefore);
  } finally {
    await rig.dispose();
  }
});
