import { describe, expect, it } from "bun:test";

import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import {
  EXI_REQUEST_FIXTURE,
  EXI_RESPONSE_FIXTURES,
} from "../../../domain/security/__tests__/iso15118Fixtures";
import {
  isValidGet15118EVCertificateRequestV201,
  isValidGet15118EVCertificateRequestV21,
  isValidGet15118EVCertificateResponseV201,
  isValidGet15118EVCertificateResponseV21,
} from "../../../../ocpp";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { canBindBunServe } from "../../../../test/bunServe";

/**
 * #537: the control-plane Get15118EVCertificate relay (2.0.1 / 2.1 M01,
 * M02) sends the EXI request it is given and returns the CSMS's answers.
 */

type Version = "OCPP-2.0.1" | "OCPP-2.1";

const VALID = {
  "OCPP-2.0.1": {
    request: isValidGet15118EVCertificateRequestV201,
    response: isValidGet15118EVCertificateResponseV201,
  },
  "OCPP-2.1": {
    request: isValidGet15118EVCertificateRequestV21,
    response: isValidGet15118EVCertificateResponseV21,
  },
} as const;

function newChargePoint(id: string, url: string, version: string): ChargePoint {
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    url,
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
  cp.events.on("error", () => undefined);
  return cp;
}

async function bootAccepted(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-10-30T00:00:00.000Z",
    interval: 300,
  });
  await csms.waitForFrame(
    (frame) => frame[0] === 2 && frame[2] === "StatusNotification",
  );
}

async function withStation(
  version: Version,
  run: (csms: MockCsms, cp: ChargePoint) => Promise<void>,
): Promise<void> {
  const csms = startMockCsms();
  const cp = newChargePoint(`CP-15118-${version}`, csms.url, version);
  try {
    cp.connect();
    await bootAccepted(csms);
    await run(csms, cp);
  } finally {
    cp.disconnect();
    await csms.stop();
  }
}

/** The `n`-th Get15118EVCertificate CALL the station sent (0-based). */
async function nthRequest(csms: MockCsms, n: number): Promise<OcppFrame> {
  await csms.waitForFrame(
    () =>
      csms.received.filter(
        (f) => f[0] === 2 && f[2] === "Get15118EVCertificate",
      ).length > n,
  );
  return csms.received.filter(
    (f) => f[0] === 2 && f[2] === "Get15118EVCertificate",
  )[n];
}

const ISO2_REQUEST = {
  iso15118SchemaVersion: "urn:iso:15118:2:2013:MsgDef",
  action: "Update" as const,
  exiRequest: EXI_REQUEST_FIXTURE,
};

describe.skipIf(!canBindBunServe())(
  "Get15118EVCertificate relay (#537)",
  () => {
    describe.each(["OCPP-2.0.1", "OCPP-2.1"] as const)("%s", (version) => {
      it("sends the EXI request and returns the CSMS answer (M01.FR.01 / M02.FR.01)", async () => {
        await withStation(version, async (csms, cp) => {
          const relayed = cp.get15118EVCertificate(ISO2_REQUEST);
          const frame = await nthRequest(csms, 0);
          expect(frame[3]).toEqual(ISO2_REQUEST);
          expect(VALID[version].request(frame[3])).toBe(true);

          const answer = {
            status: "Accepted",
            exiResponse: EXI_RESPONSE_FIXTURES[0],
          };
          expect(VALID[version].response(answer)).toBe(true);
          csms.replyCallResult(frame[1] as string, answer);

          expect(await relayed).toEqual({ responses: [answer] });
        });
      });

      it("returns a CALLERROR as the answer", async () => {
        await withStation(version, async (csms, cp) => {
          const relayed = cp.get15118EVCertificate(ISO2_REQUEST);
          const frame = await nthRequest(csms, 0);
          csms.send([4, frame[1], "InternalError", "pool unreachable", {}]);

          expect(await relayed).toEqual({
            responses: [],
            callError: {
              errorCode: "InternalError",
              errorDescription: "pool unreachable",
              errorDetails: {},
            },
          });
        });
      });
    });

    it("refuses the 2.1-only fields and an over-long exiRequest on 2.0.1, sending nothing", async () => {
      await withStation("OCPP-2.0.1", async (csms, cp) => {
        for (const request of [
          { ...ISO2_REQUEST, maximumContractCertificateChains: 2 },
          { ...ISO2_REQUEST, prioritizedEMAIDs: ["DE8ACC12345678"] },
          { ...ISO2_REQUEST, exiRequest: "A".repeat(5604) },
        ]) {
          await expect(cp.get15118EVCertificate(request)).rejects.toMatchObject(
            { name: "OcppCallRejectedError", reason: "invalid_payload" },
          );
        }
        expect(
          csms.received.some(
            (f) => f[0] === 2 && f[2] === "Get15118EVCertificate",
          ),
        ).toBe(false);
      });
    });

    it("repeats an ISO 15118-20 request while contracts remain on 2.1 (M01.FR.03 / M01.FR.06)", async () => {
      await withStation("OCPP-2.1", async (csms, cp) => {
        const request = {
          iso15118SchemaVersion: "urn:iso:std:iso:15118:-20:CommonMessages",
          action: "Install" as const,
          exiRequest: EXI_REQUEST_FIXTURE,
          maximumContractCertificateChains: 2,
          prioritizedEMAIDs: ["DE8ACC12345678"],
        };
        const relayed = cp.get15118EVCertificate(request);
        const answers = [1, 0].map((remainingContracts, i) => ({
          status: "Accepted",
          exiResponse: EXI_RESPONSE_FIXTURES[i],
          remainingContracts,
        }));
        for (const [i, answer] of answers.entries()) {
          const frame = await nthRequest(csms, i);
          expect(frame[3]).toEqual(request);
          expect(isValidGet15118EVCertificateRequestV21(frame[3])).toBe(true);
          expect(isValidGet15118EVCertificateResponseV21(answer)).toBe(true);
          csms.replyCallResult(frame[1] as string, answer);
        }

        expect(await relayed).toEqual({ responses: answers });
      });
    });
  },
);

// No server needed: these stations refuse before anything is sent.
describe("Get15118EVCertificate relay refusals (#537)", () => {
  it("refuses OCPP 1.6 and SOAP stations before sending", async () => {
    for (const [version, reason] of [
      ["OCPP-1.6J", "unsupported_action"],
      ["OCPP-1.6S", "unsupported_transport"],
    ] as const) {
      const cp = newChargePoint(`CP-15118-${version}`, "ws://x", version);
      await expect(
        cp.get15118EVCertificate(ISO2_REQUEST),
      ).rejects.toMatchObject({ name: "OcppCallRejectedError", reason });
    }
  });
});
