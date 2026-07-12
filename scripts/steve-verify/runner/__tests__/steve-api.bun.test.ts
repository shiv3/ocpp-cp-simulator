import { describe, expect, test } from "bun:test";
import {
  buildOperationBody,
  buildTransactionsQuery,
  nullableToEmpty,
  pickLatestTxPk,
} from "../steve-api";

// Every case below mirrors an actual specs/*.ts call site's `fields`
// (UI-form-shaped, string-valued) and asserts the exact JSON body that was
// live-verified against a running SteVe 3.13.0 (see the #184 Task 2
// report for the raw captures) -- these are regression pins, not
// speculative shapes.

describe("buildOperationBody", () => {
  test("throws when chargePointSelectList (cpId) is missing", () => {
    expect(() => buildOperationBody("ClearCache", {})).toThrow(
      /chargePointSelectList/,
    );
  });

  test("ClearCache / GetLocalListVersion: chargeBoxIdList only", () => {
    expect(
      buildOperationBody("ClearCache", { chargePointSelectList: "CERTCP1" }),
    ).toEqual({ chargeBoxIdList: ["CERTCP1"] });
    expect(
      buildOperationBody("GetLocalListVersion", {
        chargePointSelectList: "CERTCP1",
      }),
    ).toEqual({ chargeBoxIdList: ["CERTCP1"] });
  });

  test("Reset: UI's HARD/SOFT -> wire-cased Hard/Soft", () => {
    expect(
      buildOperationBody("Reset", {
        chargePointSelectList: "CERTCP1",
        resetType: "HARD",
      }),
    ).toEqual({ chargeBoxIdList: ["CERTCP1"], resetType: "Hard" });
    expect(
      buildOperationBody("Reset", {
        chargePointSelectList: "CERTCP1",
        resetType: "SOFT",
      }),
    ).toEqual({ chargeBoxIdList: ["CERTCP1"], resetType: "Soft" });
  });

  test("UnlockConnector: connectorId coerced to a number", () => {
    expect(
      buildOperationBody("UnlockConnector", {
        chargePointSelectList: "CERTCP1",
        connectorId: "1",
      }),
    ).toEqual({ chargeBoxIdList: ["CERTCP1"], connectorId: 1 });
  });

  test('GetConfiguration: no confKeyList field -> omitted (means "all keys")', () => {
    const body = buildOperationBody("GetConfiguration", {
      chargePointSelectList: "CERTCP1",
    });
    expect(body).toEqual({ chargeBoxIdList: ["CERTCP1"] });
    // JSON.stringify (what actually goes over the wire) drops
    // undefined-valued keys entirely -- that's the real contract; `in`
    // would still see the key (present, just undefined-valued).
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      chargeBoxIdList: ["CERTCP1"],
    });
  });

  test("GetConfiguration: confKeyList -> string[]", () => {
    expect(
      buildOperationBody("GetConfiguration", {
        chargePointSelectList: "CERTCP1",
        confKeyList: "HeartbeatInterval",
      }),
    ).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      confKeyList: ["HeartbeatInterval"],
    });
  });

  test("ChangeConfiguration: keyType passes through unchanged (matches the Java enum name)", () => {
    expect(
      buildOperationBody("ChangeConfiguration", {
        chargePointSelectList: "CERTCP1",
        keyType: "PREDEFINED",
        confKey: "MeterValueSampleInterval",
        customConfKey: "",
        value: "10",
      }),
    ).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      keyType: "PREDEFINED",
      confKey: "MeterValueSampleInterval",
      customConfKey: "",
      value: "10",
    });
  });

  test("SendLocalList: listVersion numeric, updateType title-cased, addUpdateList as an array", () => {
    expect(
      buildOperationBody("SendLocalList", {
        chargePointSelectList: "CERTCP1",
        listVersion: "1",
        updateType: "FULL",
        addUpdateList: "CERT-TAG-1",
      }),
    ).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      listVersion: 1,
      updateType: "Full",
      addUpdateList: ["CERT-TAG-1"],
    });

    expect(
      buildOperationBody("SendLocalList", {
        chargePointSelectList: "CERTCP1",
        listVersion: "2",
        updateType: "DIFFERENTIAL",
        addUpdateList: "CERT-TAG-2",
      }),
    ).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      listVersion: 2,
      updateType: "Differential",
      addUpdateList: ["CERT-TAG-2"],
    });
  });

  test('ReserveNow: expiry reformatted from steve.ts\'s "YYYY-MM-DD HH:MM" to ISO-8601', () => {
    expect(
      buildOperationBody("ReserveNow", {
        chargePointSelectList: "CERTCP1",
        connectorId: "1",
        expiry: "2026-07-12 19:12",
        idTag: "CERT-TAG-1",
      }),
    ).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      connectorId: 1,
      expiry: "2026-07-12T19:12:00.000Z",
      idTag: "CERT-TAG-1",
    });
  });

  test("CancelReservation: reservationId coerced to a number", () => {
    expect(
      buildOperationBody("CancelReservation", {
        chargePointSelectList: "CERTCP1",
        reservationId: "68",
      }),
    ).toEqual({ chargeBoxIdList: ["CERTCP1"], reservationId: 68 });
  });

  test("RemoteStartTransaction: empty chargingProfilePk is omitted, not coerced to 0", () => {
    const body = buildOperationBody("RemoteStartTransaction", {
      chargePointSelectList: "CERTCP1",
      connectorId: "1",
      idTag: "CERT-TAG-1",
      chargingProfilePk: "",
    });
    expect(body).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      connectorId: 1,
      idTag: "CERT-TAG-1",
    });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      connectorId: 1,
      idTag: "CERT-TAG-1",
    });
  });

  test("RemoteStartTransaction: non-empty chargingProfilePk is coerced to a number", () => {
    expect(
      buildOperationBody("RemoteStartTransaction", {
        chargePointSelectList: "CERTCP1",
        connectorId: "1",
        idTag: "CERT-TAG-1",
        chargingProfilePk: "2",
      }),
    ).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      connectorId: 1,
      idTag: "CERT-TAG-1",
      chargingProfilePk: 2,
    });
  });

  test("RemoteStopTransaction: transactionId coerced to a number", () => {
    expect(
      buildOperationBody("RemoteStopTransaction", {
        chargePointSelectList: "CERTCP1",
        transactionId: "180",
      }),
    ).toEqual({ chargeBoxIdList: ["CERTCP1"], transactionId: 180 });
  });

  test("TriggerMessage: empty connectorId is omitted", () => {
    const body = buildOperationBody("TriggerMessage", {
      chargePointSelectList: "CERTCP1",
      triggerMessage: "Heartbeat",
      connectorId: "",
    });
    expect(body).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      triggerMessage: "Heartbeat",
    });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      triggerMessage: "Heartbeat",
    });
  });

  test("GetDiagnostics: location passes through", () => {
    expect(
      buildOperationBody("GetDiagnostics", {
        chargePointSelectList: "CERTCP1",
        location: "http://app:9/upload",
      }),
    ).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      location: "http://app:9/upload",
    });
  });

  test("UpdateFirmware: retrieveDateTime reformatted to ISO-8601", () => {
    expect(
      buildOperationBody("UpdateFirmware", {
        chargePointSelectList: "CERTCP1",
        location: "http://example.com/fw.bin",
        retrieveDateTime: "2026-07-12 19:03",
      }),
    ).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      location: "http://example.com/fw.bin",
      retrieveDateTime: "2026-07-12T19:03:00.000Z",
    });
  });

  test("SetChargingProfile: empty transactionId is omitted (no active tx)", () => {
    const body = buildOperationBody("SetChargingProfile", {
      chargePointSelectList: "CERTCP1",
      chargingProfilePk: "1",
      connectorId: "1",
      transactionId: "",
    });
    expect(body).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      chargingProfilePk: 1,
      connectorId: 1,
    });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      chargingProfilePk: 1,
      connectorId: 1,
    });
  });

  test("SetChargingProfile: non-empty transactionId is coerced to a number", () => {
    expect(
      buildOperationBody("SetChargingProfile", {
        chargePointSelectList: "CERTCP1",
        chargingProfilePk: "2",
        connectorId: "1",
        transactionId: "180",
      }),
    ).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      chargingProfilePk: 2,
      connectorId: 1,
      transactionId: 180,
    });
  });

  test("GetCompositeSchedule: durationInSeconds/connectorId numeric, chargingRateUnit passthrough", () => {
    expect(
      buildOperationBody("GetCompositeSchedule", {
        chargePointSelectList: "CERTCP1",
        connectorId: "1",
        durationInSeconds: "600",
        chargingRateUnit: "W",
      }),
    ).toEqual({
      chargeBoxIdList: ["CERTCP1"],
      connectorId: 1,
      durationInSeconds: 600,
      chargingRateUnit: "W",
    });
  });

  test("ClearChargingProfile: chargingProfilePk coerced to a number", () => {
    expect(
      buildOperationBody("ClearChargingProfile", {
        chargePointSelectList: "CERTCP1",
        chargingProfilePk: "1",
      }),
    ).toEqual({ chargeBoxIdList: ["CERTCP1"], chargingProfilePk: 1 });
  });

  test("unsupported operation name throws with a driver-fallback hint", () => {
    expect(() =>
      buildOperationBody("SomeFutureOp", { chargePointSelectList: "CERTCP1" }),
    ).toThrow(/STEVE_DRIVER=ui/);
  });

  test("a non-numeric string for a numeric field throws instead of silently coercing", () => {
    expect(() =>
      buildOperationBody("UnlockConnector", {
        chargePointSelectList: "CERTCP1",
        connectorId: "not-a-number",
      }),
    ).toThrow(/integer/);
  });
});

// ---------------------------------------------------------------------------
// SteveApiDb (issue #184 Task 3) -- pure helpers. The actual fetch()-driven
// class methods (latestTxPk/waitActiveTxPk/closeStaleTx/txIdTag/
// txStopTimestamp/txStopReason/txCountForTag) are exercised live against a
// running SteVe 3.13.0 instead of mocked here -- same split as
// buildOperationBody() above vs. SteveApiOps#op() (see the #184 Task 3
// report for the live proof).
// ---------------------------------------------------------------------------

describe("pickLatestTxPk", () => {
  test('empty list -> ""', () => {
    expect(pickLatestTxPk([])).toBe("");
  });

  test("takes the FIRST element's id (SteVe orders /transactions by transaction_pk DESC -- source-verified, see steve-api.ts's header)", () => {
    expect(pickLatestTxPk([{ id: 183 }, { id: 180 }, { id: 42 }])).toBe("183");
  });

  test("stringifies a numeric id", () => {
    expect(pickLatestTxPk([{ id: 7 }])).toBe("7");
  });
});

describe("nullableToEmpty", () => {
  test('null -> "" (REST\'s not-set representation)', () => {
    expect(nullableToEmpty(null)).toBe("");
  });

  test('undefined -> "" (transaction not found upstream)', () => {
    expect(nullableToEmpty(undefined)).toBe("");
  });

  test("a real value passes through unchanged", () => {
    expect(nullableToEmpty("2026-07-12T19:16:11.836Z")).toBe(
      "2026-07-12T19:16:11.836Z",
    );
  });

  test("empty string passes through unchanged (distinct from null)", () => {
    expect(nullableToEmpty("")).toBe("");
  });
});

describe("buildTransactionsQuery", () => {
  test("no params -> empty query string (SteVe's TransactionQueryFormForApi already defaults type/periodType to ALL)", () => {
    expect(buildTransactionsQuery({})).toBe("");
  });

  test("chargeBoxId only", () => {
    expect(buildTransactionsQuery({ chargeBoxId: "CERTCP1" })).toBe(
      "chargeBoxId=CERTCP1",
    );
  });

  test("chargeBoxId + ocppIdTag + type, in insertion order", () => {
    expect(
      buildTransactionsQuery({
        chargeBoxId: "CERTCP1",
        ocppIdTag: "CERT028",
        type: "ACTIVE",
      }),
    ).toBe("chargeBoxId=CERTCP1&ocppIdTag=CERT028&type=ACTIVE");
  });

  test("type is passed through UPPERCASE verbatim -- SteVe's QueryType enum is case-sensitive (live-verified: ?type=Active 400s, ?type=ACTIVE 200s)", () => {
    expect(buildTransactionsQuery({ type: "STOPPED" })).toBe("type=STOPPED");
  });
});
