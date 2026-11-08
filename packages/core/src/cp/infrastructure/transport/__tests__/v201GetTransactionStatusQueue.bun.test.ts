import { describe, expect, it } from "bun:test";
import { handleGetTransactionStatusV201 } from "../v201/transactionControlV201";
import type { V201InboundContext } from "../v201/inboundRegistryV201";

/** #554, E14: `messagesInQueue` comes from the offline queue. */
function ctx(
  hasTransactionEventsToDeliver?: (id?: string) => boolean,
): V201InboundContext {
  return {
    chargePoint: { connectors: new Map() },
    hasTransactionEventsToDeliver,
  } as unknown as V201InboundContext;
}

describe("GetTransactionStatus messagesInQueue (#554)", () => {
  it("asks the queue with the requested transaction id", () => {
    const asked: Array<string | undefined> = [];
    const context = ctx((id) => {
      asked.push(id);
      return id === "tx-1";
    });
    expect(
      handleGetTransactionStatusV201({ transactionId: "tx-1" }, context)
        .response,
    ).toEqual({ ongoingIndicator: false, messagesInQueue: true });
    expect(
      handleGetTransactionStatusV201({ transactionId: "tx-2" }, context)
        .response,
    ).toEqual({ ongoingIndicator: false, messagesInQueue: false });
    expect(asked).toEqual(["tx-1", "tx-2"]);
  });

  it("asks for any transaction when the request names none", () => {
    expect(
      handleGetTransactionStatusV201(
        {},
        ctx((id) => id === undefined),
      ).response,
    ).toEqual({ ongoingIndicator: false, messagesInQueue: true });
  });

  it("answers false without a queue", () => {
    expect(handleGetTransactionStatusV201({}, ctx()).response).toEqual({
      ongoingIndicator: false,
      messagesInQueue: false,
    });
  });
});
