import { describe, expect, it } from "vitest";
import {
  createCorrelator,
  createViewerStore,
  type EntryCorrelation,
  type TraceEntry,
  type ViewerEntry,
} from "@open-ocpp-trace/viewer-core";

import { LogLevel, LogType } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import type { GlobalLogEntry } from "./globalLogsContext";
import {
  SIMULATOR_SOURCE,
  createTraceFeed,
  toSerializedLogLine,
} from "./traceFeed";

let at = Date.parse("2026-11-10T09:00:00.000Z");

function line(
  seq: number,
  cpId: string,
  message: string,
  type: LogType = LogType.WEBSOCKET,
): GlobalLogEntry {
  at += 1;
  return {
    cpId,
    seq,
    entry: { timestamp: new Date(at), level: LogLevel.INFO, type, message },
  };
}

const sent = (seq: number, cpId: string, frame: unknown[]) =>
  line(seq, cpId, `Sent: ${JSON.stringify(frame)}`);
const received = (seq: number, cpId: string, frame: unknown[]) =>
  line(seq, cpId, `Received: ${JSON.stringify(frame)}`);

/** The provider's buffer is newest first. */
const newestFirst = (items: GlobalLogEntry[]) => [...items].reverse();

function collect() {
  const batches: ViewerEntry[][] = [];
  const feed = createTraceFeed({
    push: (entries) => batches.push([...entries]),
  });
  return { feed, batches, all: () => batches.flat() };
}

describe("toSerializedLogLine", () => {
  it("serializes a buffer entry the way TraceWriter does", () => {
    const item: GlobalLogEntry = {
      cpId: "CP001",
      seq: 7,
      entry: {
        timestamp: new Date("2026-06-01T11:18:38.409Z"),
        level: LogLevel.WARN,
        type: LogType.WEBSOCKET,
        message: "Sent: []",
      },
    };
    expect(toSerializedLogLine(item)).toEqual({
      timestamp: "2026-06-01T11:18:38.409Z",
      level: "WARN",
      type: "WebSocket",
      message: "Sent: []",
      cpId: "CP001",
    });
  });
});

describe("createTraceFeed", () => {
  it("turns wire lines into entries with ids from seq, and skips the other lines", () => {
    const { feed, all } = collect();
    feed.ingest(
      newestFirst([
        sent(0, "CP001", [2, "a-1", "BootNotification", { vendor: "X" }]),
        line(1, "CP001", "Boot notification accepted", LogType.OCPP),
        line(2, "CP001", "SOAP POST Heartbeat: <soap:Envelope/>", LogType.OCPP),
        received(3, "CP001", [3, "a-1", { status: "Accepted" }]),
      ]),
    );

    const entries = all();
    expect(entries.map((entry) => entry.id)).toEqual([
      "sim-seq-0",
      "sim-seq-3",
    ]);
    const [call, result] = entries as TraceEntry[];
    expect(call?.record).toMatchObject({
      direction: "cp-to-csms",
      messageType: "CALL",
      action: "BootNotification",
      chargePointId: "CP001",
    });
    // The response's action is back-filled from its CALL.
    expect(result?.record).toMatchObject({
      direction: "csms-to-cp",
      messageType: "CALLRESULT",
      action: "BootNotification",
    });
    expect(call?.metadata).toEqual({
      chargePointId: "CP001",
      source: SIMULATOR_SOURCE,
    });
  });

  it("pushes only the lines it has not seen, oldest first, whatever the re-delivery", () => {
    const { feed, batches } = collect();
    const first = [
      sent(10, "CP001", [2, "h-1", "Heartbeat", {}]),
      received(11, "CP001", [3, "h-1", { currentTime: "now" }]),
    ];
    feed.ingest(newestFirst(first));
    feed.ingest(newestFirst(first));
    const second = [...first, sent(12, "CP001", [2, "h-2", "Heartbeat", {}])];
    feed.ingest(newestFirst(second));

    expect(batches.map((batch) => batch.map((entry) => entry.id))).toEqual([
      ["sim-seq-10", "sim-seq-11"],
      ["sim-seq-12"],
    ]);
  });

  it("lists a dropped gap before the new lines when the ring buffer overflowed past unseen lines", () => {
    const { feed, batches } = collect();
    feed.ingest(newestFirst([sent(0, "CP001", [2, "h-1", "Heartbeat", {}])]));
    // Lines 1 and 2 left the ring buffer before the next delivery.
    const later = sent(3, "CP001", [2, "h-2", "Heartbeat", {}]);
    feed.ingest(newestFirst([later]));

    expect(batches[1]).toEqual([
      {
        kind: "gap",
        id: "sim-gap-3",
        reason: "dropped",
        timestamp: later.entry.timestamp.toISOString(),
      },
      expect.objectContaining({ kind: "trace", id: "sim-seq-3" }),
    ]);
  });

  it("lists no gap when the next delivery follows on, even when its lines are not frames", () => {
    const { feed, batches } = collect();
    feed.ingest(newestFirst([sent(0, "CP001", [2, "h-1", "Heartbeat", {}])]));
    feed.ingest(
      newestFirst([
        line(1, "CP001", "Heartbeat sent", LogType.HEARTBEAT),
        sent(2, "CP001", [2, "h-2", "Heartbeat", {}]),
      ]),
    );

    expect(batches[1]?.map((entry) => entry.kind)).toEqual(["trace"]);
  });

  it("pushes nothing for a delivery without a frame", () => {
    const { feed, batches } = collect();
    feed.ingest(newestFirst([line(0, "CP001", "Connected", LogType.OCPP)]));
    feed.ingest([]);

    expect(batches).toEqual([]);
  });

  it("attaches an inbound validation to the CSMS CALL of the same delivery", () => {
    const { feed, all } = collect();
    feed.ingest(
      newestFirst([
        received(0, "CP001", [2, "csms-1", "Reset", { type: "Bogus" }]),
        line(
          1,
          "CP001",
          `Inbound validation: ${JSON.stringify({
            messageId: "csms-1",
            mode: "strict",
            errorCode: "FormationViolation",
            description: "bad type",
          })}`,
        ),
      ]),
    );

    const [call] = all() as TraceEntry[];
    expect(all()).toHaveLength(1);
    expect(call?.record.meta).toEqual({
      validation: {
        mode: "strict",
        errorCode: "FormationViolation",
        description: "bad type",
      },
    });
  });
});

describe("correlation of colliding CSMS message ids", () => {
  // Both charge points receive a CALL with the same id before either
  // answers. The answers come back in either order, so pairing by order
  // alone (first or last pending CALL) fails one of them.
  const calls = [
    received(0, "CP001", [2, "csms-0001", "GetConfiguration", {}]),
    received(1, "CP002", [2, "csms-0001", "TriggerMessage", {}]),
  ];
  const answer = (seq: number, cpId: string) =>
    sent(seq, cpId, [3, "csms-0001", { cpId }]);

  function correlate(lines: GlobalLogEntry[]): {
    get: (id: string) => EntryCorrelation | undefined;
    entries: TraceEntry[];
  } {
    const store = createViewerStore();
    const correlator = createCorrelator({ scope: "chargePoint" });
    correlator.connect(store);
    const feed = createTraceFeed({
      push: (entries) =>
        store.apply(entries.map((entry) => ({ type: "add", entry }))),
    });
    feed.ingest(newestFirst(lines));
    return {
      get: (id) => correlator.get(id),
      entries: store.toArray() as TraceEntry[],
    };
  }

  const orders = [
    {
      name: "CP002 first",
      lines: [...calls, answer(2, "CP002"), answer(3, "CP001")],
      callOf: { "sim-seq-2": "sim-seq-1", "sim-seq-3": "sim-seq-0" },
      actions: ["TriggerMessage", "GetConfiguration"],
    },
    {
      name: "CP001 first",
      lines: [...calls, answer(2, "CP001"), answer(3, "CP002")],
      callOf: { "sim-seq-2": "sim-seq-0", "sim-seq-3": "sim-seq-1" },
      actions: ["GetConfiguration", "TriggerMessage"],
    },
  ];

  it.each(orders)(
    "pairs each response with the CALL of its own charge point, $name",
    ({ lines, callOf }) => {
      const { get } = correlate(lines);
      const pairs = Object.fromEntries(
        Object.keys(callOf).map((id) => {
          const correlation = get(id);
          return [
            id,
            correlation?.role === "response" ? correlation.callId : "none",
          ];
        }),
      );

      expect(pairs).toEqual(callOf);
    },
  );

  it.each(orders)(
    "back-fills each response's action from its own charge point's CALL, $name",
    ({ lines, actions }) => {
      const { entries } = correlate(lines);
      expect(entries.slice(2).map((entry) => entry.record.action)).toEqual(
        actions,
      );
    },
  );
});
