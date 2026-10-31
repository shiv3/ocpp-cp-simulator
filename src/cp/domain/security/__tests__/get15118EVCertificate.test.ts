import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OcppCallNoAnswerError,
  OcppCallRejectedError,
} from "../../errors/OcppCallErrors";
import type { OcppCallOutcome } from "../../types/OcppCall";
import {
  get15118EVCertificatePayload,
  relayGet15118EVCertificate,
} from "../get15118EVCertificate";
import { EXI_REQUEST_FIXTURE, EXI_RESPONSE_FIXTURES } from "./iso15118Fixtures";

function callResult(payload: unknown): OcppCallOutcome {
  return { kind: "callResult", messageId: "m", sentFrame: "[]", payload };
}

function sender(answers: Array<OcppCallOutcome | Error>) {
  const sent: unknown[] = [];
  const send = vi.fn(async (payload: Record<string, unknown>) => {
    sent.push(payload);
    const answer = answers.shift();
    if (answer === undefined) throw new Error("no more answers scripted");
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { send, sent };
}

const ISO2 = {
  iso15118SchemaVersion: "urn:iso:15118:2:2013:MsgDef",
  action: "Install" as const,
  exiRequest: EXI_REQUEST_FIXTURE,
};

const ISO20 = {
  iso15118SchemaVersion: "urn:iso:std:iso:15118:-20:CommonMessages",
  action: "Install" as const,
  exiRequest: EXI_REQUEST_FIXTURE,
  maximumContractCertificateChains: 3,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("get15118EVCertificatePayload", () => {
  it("passes the request through, leaving absent 2.1 fields out", () => {
    expect(get15118EVCertificatePayload(ISO2)).toEqual(ISO2);
    expect(
      get15118EVCertificatePayload({
        ...ISO20,
        prioritizedEMAIDs: ["DE8ACC12345678"],
      }),
    ).toEqual({ ...ISO20, prioritizedEMAIDs: ["DE8ACC12345678"] });
  });
});

describe("relayGet15118EVCertificate (M01 / M02)", () => {
  it("sends one request and returns the CSMS answer verbatim", async () => {
    const answer = {
      status: "Accepted",
      exiResponse: EXI_RESPONSE_FIXTURES[0],
    };
    const { send, sent } = sender([callResult(answer)]);

    await expect(relayGet15118EVCertificate(ISO2, send)).resolves.toEqual({
      responses: [answer],
    });
    expect(sent).toEqual([ISO2]);
  });

  it("does not repeat an ISO 15118-2 request, whatever remainingContracts says", async () => {
    const { send } = sender([
      callResult({
        status: "Accepted",
        exiResponse: EXI_RESPONSE_FIXTURES[0],
        remainingContracts: 2,
      }),
    ]);

    const result = await relayGet15118EVCertificate(ISO2, send);

    expect(result.responses).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("repeats an ISO 15118-20 request while remainingContracts > 0 (2.1 M01.FR.06)", async () => {
    const answers = [2, 1, 0].map((remainingContracts, i) => ({
      status: "Accepted",
      exiResponse: EXI_RESPONSE_FIXTURES[i],
      remainingContracts,
    }));
    const { send, sent } = sender(answers.map(callResult));

    await expect(relayGet15118EVCertificate(ISO20, send)).resolves.toEqual({
      responses: answers,
    });
    // The same request every time.
    expect(sent).toEqual([ISO20, ISO20, ISO20]);
  });

  it("stops at a Failed answer, or one without remainingContracts", async () => {
    for (const last of [
      { status: "Failed", exiResponse: "", remainingContracts: 1 },
      { status: "Accepted", exiResponse: EXI_RESPONSE_FIXTURES[0] },
    ]) {
      const { send } = sender([callResult(last)]);
      const result = await relayGet15118EVCertificate(ISO20, send);
      expect(result.responses).toEqual([last]);
    }
  });

  it("stops when remainingContracts does not go down, and never sends more than maximumContractCertificateChains", async () => {
    const stuck = {
      status: "Accepted",
      exiResponse: EXI_RESPONSE_FIXTURES[0],
      remainingContracts: 5,
    };
    const warn = vi.fn();
    const { send } = sender([callResult(stuck), callResult(stuck)]);
    const result = await relayGet15118EVCertificate(ISO20, send, { warn });
    expect(result.responses).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("remainingContracts did not decrease"),
    );

    const counting = [9, 8, 7, 6].map((remainingContracts) =>
      callResult({ status: "Accepted", exiResponse: "", remainingContracts }),
    );
    const capped = sender(counting);
    const many = await relayGet15118EVCertificate(ISO20, capped.send, {
      warn,
    });
    expect(many.responses).toHaveLength(3);
  });

  it("returns a CALLERROR as the answer and stops there", async () => {
    const first = {
      status: "Accepted",
      exiResponse: EXI_RESPONSE_FIXTURES[0],
      remainingContracts: 1,
    };
    const { send } = sender([
      callResult(first),
      {
        kind: "callError",
        messageId: "m",
        sentFrame: "[]",
        errorCode: "InternalError",
        errorDescription: "pool down",
        errorDetails: {},
      },
    ]);

    await expect(relayGet15118EVCertificate(ISO20, send)).resolves.toEqual({
      responses: [first],
      callError: {
        errorCode: "InternalError",
        errorDescription: "pool down",
        errorDetails: {},
      },
    });
  });

  it("throws when the first request gets no answer, and keeps the answers already had otherwise", async () => {
    const noAnswer = new OcppCallNoAnswerError("dropped", "socket closed");
    await expect(
      relayGet15118EVCertificate(ISO2, sender([noAnswer]).send),
    ).rejects.toBe(noAnswer);

    const first = {
      status: "Accepted",
      exiResponse: EXI_RESPONSE_FIXTURES[0],
      remainingContracts: 1,
    };
    await expect(
      relayGet15118EVCertificate(
        ISO20,
        sender([callResult(first), noAnswer]).send,
      ),
    ).resolves.toEqual({ responses: [first], noAnswer: "dropped" });
  });

  it("propagates a refusal of the request", async () => {
    const refused = new OcppCallRejectedError("invalid_payload", "too long");
    await expect(
      relayGet15118EVCertificate(ISO2, sender([refused]).send),
    ).rejects.toBe(refused);
  });

  it("shares one time budget across the repeated requests", async () => {
    vi.useFakeTimers();
    const send = vi.fn(
      (): Promise<OcppCallOutcome> =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                callResult({
                  status: "Accepted",
                  exiResponse: "",
                  remainingContracts: 99 - send.mock.calls.length,
                }),
              ),
            400,
          ),
        ),
    );
    const relayed = relayGet15118EVCertificate(
      { ...ISO20, maximumContractCertificateChains: 50 },
      send,
      { budgetMs: 1000 },
    );

    await vi.advanceTimersByTimeAsync(1000);

    // 400 ms + 400 ms answered; the third request outlives the budget.
    await expect(relayed).resolves.toMatchObject({ noAnswer: "timeout" });
    expect((await relayed).responses).toHaveLength(2);
  });

  it("sends no further request once the budget is spent", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const send = vi.fn(async (): Promise<OcppCallOutcome> => {
      // The answer lands exactly when the budget runs out.
      vi.setSystemTime(started + 1000);
      return callResult({
        status: "Accepted",
        exiResponse: "",
        remainingContracts: 5,
      });
    });

    const relayed = await relayGet15118EVCertificate(ISO20, send, {
      budgetMs: 1000,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(relayed).toMatchObject({ noAnswer: "timeout" });
    expect(relayed.responses).toHaveLength(1);
  });

  it("throws a timeout when the budget runs out before the first answer", async () => {
    vi.useFakeTimers();
    const send = vi.fn(
      (): Promise<OcppCallOutcome> => new Promise(() => undefined),
    );
    const relayed = relayGet15118EVCertificate(ISO2, send, { budgetMs: 1000 });
    const settled = expect(relayed).rejects.toMatchObject({
      name: "OcppCallNoAnswerError",
      reason: "timeout",
    });

    await vi.advanceTimersByTimeAsync(1000);
    await settled;
  });
});
