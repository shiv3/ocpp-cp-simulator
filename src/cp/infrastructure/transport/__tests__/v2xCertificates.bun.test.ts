import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import * as x509 from "@peculiar/x509";

import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { BunSqliteDatabase } from "../../../domain/persistence/BunSqliteDatabase";
import type { Database } from "../../../domain/persistence/Database";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { computeCertificateHashData } from "../../../domain/security/certificateHash";
import { generateCsr } from "../../../domain/security/csr";
import {
  leafForCsr,
  selfSignedRoot,
  subCa,
} from "../../../domain/security/__tests__/certificateFixtures";
import {
  isValidGetVariablesResponseV201,
  isValidGetVariablesResponseV21,
} from "../../../../ocpp";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { canBindBunServe } from "../../../../test/bunServe";

/**
 * #456: OCPP 2.0.1 / 2.1 certificate management runs on the station's
 * CertificateStore (M03 GetInstalledCertificateIds, M04 DeleteCertificate,
 * M05 InstallCertificate, A02 SignCertificate / CertificateSigned) instead
 * of answering fixed negative acknowledgements.
 */

x509.cryptoProvider.set(globalThis.crypto as Crypto);

type Version = "OCPP-2.0.1" | "OCPP-2.1";

interface HashData {
  hashAlgorithm: string;
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
}

interface HashDataChain {
  certificateType: string;
  certificateHashData: HashData;
  childCertificateHashData?: HashData[];
}

async function bootAccepted(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-10-29T00:00:00.000Z",
    interval: 300,
  });
  await csms.waitForFrame(
    (frame) =>
      frame[0] === 2 &&
      frame[2] === "StatusNotification" &&
      (frame[3] as { evseId?: number }).evseId === 1 &&
      (frame[3] as { connectorStatus?: string }).connectorStatus ===
        "Available",
  );
}

function newChargePoint(
  id: string,
  url: string,
  version: Version,
  database: Database | null = null,
): ChargePoint {
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    url,
    null,
    null,
    database,
    {},
    [],
    version,
    {},
  );
  cp.events.on("error", () => undefined);
  return cp;
}

let callSeq = 0;

/** Sends a CSMS CALL and resolves with the station's answer frame. */
async function call(
  csms: MockCsms,
  action: string,
  payload: unknown,
): Promise<OcppFrame> {
  const id = `${action}-${++callSeq}`;
  csms.send([2, id, action, payload]);
  return csms.waitForFrame(
    (frame) => (frame[0] === 3 || frame[0] === 4) && frame[1] === id,
  );
}

async function result(
  csms: MockCsms,
  action: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const frame = await call(csms, action, payload);
  expect(frame[0]).toBe(3);
  return frame[2] as Record<string, unknown>;
}

async function withStation(
  version: Version,
  run: (csms: MockCsms, cp: ChargePoint) => Promise<void>,
  database: Database | null = null,
  id = `CP-CERT-${version}`,
): Promise<void> {
  const csms = startMockCsms();
  const cp = newChargePoint(id, csms.url, version, database);
  try {
    cp.connect();
    await bootAccepted(csms);
    await run(csms, cp);
  } finally {
    cp.disconnect();
    await csms.stop();
  }
}

describe.skipIf(!canBindBunServe())(
  "OCPP 2.x certificate management (#456)",
  () => {
    describe.each(["OCPP-2.0.1", "OCPP-2.1"] as const)("%s", (version) => {
      it("reports SecurityCtrlr.CertificateEntries from the store (#537)", async () => {
        const entries = async (csms: MockCsms): Promise<unknown> => {
          const answer = await result(csms, "GetVariables", {
            getVariableData: [
              {
                component: { name: "SecurityCtrlr" },
                variable: { name: "CertificateEntries" },
              },
            ],
          });
          const validate =
            version === "OCPP-2.1"
              ? isValidGetVariablesResponseV21
              : isValidGetVariablesResponseV201;
          expect(validate(answer)).toBe(true);
          return (answer.getVariableResult as { attributeValue?: string }[])[0]
            .attributeValue;
        };
        const db = BunSqliteDatabase.open(":memory:");
        const id = `CP-CERT-ENTRIES-${version}`;
        await withStation(
          version,
          async (csms) => {
            expect(await entries(csms)).toBe("0");
            const root = await selfSignedRoot("0a", "Entries Root");
            await result(csms, "InstallCertificate", {
              certificateType: "CSMSRootCertificate",
              certificate: root.pem,
            });
            expect(await entries(csms)).toBe("1");
          },
          db,
          id,
        );
        // Restarted on the same database: the count is read back.
        await withStation(
          version,
          async (csms) => {
            expect(await entries(csms)).toBe("1");
          },
          db,
          id,
        );
        db.close();
      });

      it("installs, lists and deletes a root certificate (M05, M03, M04)", async () => {
        await withStation(version, async (csms) => {
          const root = await selfSignedRoot("0A", "CSMS Root");

          expect(
            await result(csms, "InstallCertificate", {
              certificateType: "CSMSRootCertificate",
              certificate: root.pem,
            }),
          ).toEqual({ status: "Accepted" });

          const listed = await result(csms, "GetInstalledCertificateIds", {
            certificateType: ["CSMSRootCertificate"],
          });
          expect(listed.status).toBe("Accepted");
          const chain = listed.certificateHashDataChain as HashDataChain[];
          expect(chain).toHaveLength(1);
          expect(chain[0].certificateType).toBe("CSMSRootCertificate");
          expect(chain[0].certificateHashData.serialNumber).toBe("a");
          expect(chain[0].childCertificateHashData).toBeUndefined();

          expect(
            await result(csms, "GetInstalledCertificateIds", {
              certificateType: ["ManufacturerRootCertificate"],
            }),
          ).toEqual({ status: "NotFound" });

          expect(
            await result(csms, "DeleteCertificate", {
              certificateHashData: chain[0].certificateHashData,
            }),
          ).toEqual({ status: "Accepted" });
          expect(await result(csms, "GetInstalledCertificateIds", {})).toEqual({
            status: "NotFound",
          });
        });
      });

      it("answers a query and a delete sent right after an install as if it had completed", async () => {
        await withStation(version, async (csms) => {
          const root = await selfSignedRoot("0B", "Back to back");
          const hash = await computeCertificateHashData(root.pem);
          const answer = (id: string) =>
            csms.waitForFrame(
              (frame) => (frame[0] === 3 || frame[0] === 4) && frame[1] === id,
            );
          const install = { certificateType: "CSMSRootCertificate" };

          csms.send([
            2,
            "b2b-install-1",
            "InstallCertificate",
            { ...install, certificate: root.pem },
          ]);
          csms.send([2, "b2b-get", "GetInstalledCertificateIds", {}]);
          expect((await answer("b2b-install-1"))[2]).toEqual({
            status: "Accepted",
          });
          const listed = (await answer("b2b-get"))[2] as {
            certificateHashDataChain?: HashDataChain[];
          };
          expect(listed.certificateHashDataChain).toHaveLength(1);

          csms.send([
            2,
            "b2b-install-2",
            "InstallCertificate",
            { ...install, certificate: root.pem },
          ]);
          csms.send([
            2,
            "b2b-delete",
            "DeleteCertificate",
            { certificateHashData: hash },
          ]);
          expect((await answer("b2b-install-2"))[2]).toEqual({
            status: "Accepted",
          });
          expect((await answer("b2b-delete"))[2]).toEqual({
            status: "Accepted",
          });
          expect(await result(csms, "GetInstalledCertificateIds", {})).toEqual({
            status: "NotFound",
          });
        });
      });

      it("rejects a malformed certificate and answers NotFound for an unknown hash (M05.FR.07, M04.FR.04)", async () => {
        await withStation(version, async (csms, cp) => {
          expect(
            await result(csms, "InstallCertificate", {
              certificateType: "ManufacturerRootCertificate",
              certificate: "-----BEGIN CERTIFICATE-----\nnope\n",
            }),
          ).toEqual({ status: "Rejected" });
          expect(cp.certificateStore.listRootCertificates()).toEqual([]);

          expect(
            await result(csms, "DeleteCertificate", {
              certificateHashData: {
                hashAlgorithm: "SHA256",
                issuerNameHash: "00",
                issuerKeyHash: "00",
                serialNumber: "01",
              },
            }),
          ).toEqual({ status: "NotFound" });
        });
      });

      it("applies a signed chain to the CSR it sent with SignCertificate (A02)", async () => {
        await withStation(version, async (csms, cp) => {
          const root = await selfSignedRoot("01", "CPO Root");
          const sent = cp.sendSignCertificate();
          const sign = await csms.waitForCall("SignCertificate");
          await sent;
          const { csr } = sign.payload as { csr: string };
          expect(Object.keys(sign.payload as object)).toEqual(["csr"]);
          expect(
            cp.certificateStore.pendingCsr("ChargingStationCertificate"),
          ).toBe(csr);
          csms.replyCallResult(sign.messageId, { status: "Accepted" });

          const leaf = await leafForCsr("02", csr, root);
          expect(
            await result(csms, "CertificateSigned", {
              certificateChain: leaf,
              certificateType: "ChargingStationCertificate",
            }),
          ).toEqual({ status: "Accepted" });
          expect(
            cp.certificateStore.pendingCsr("ChargingStationCertificate"),
          ).toBeUndefined();

          // The Charging Station certificate is stored and cannot be
          // deleted (M04.FR.06).
          const [stored] = cp.certificateStore.listSignedChains();
          expect(stored.pems).toEqual([leaf.trim()]);
          expect(
            await result(csms, "DeleteCertificate", {
              certificateHashData: stored.hashData[0],
            }),
          ).toEqual({ status: "Failed" });
        });
      });

      it("treats an absent certificateType on CertificateSigned as the Charging Station certificate", async () => {
        await withStation(version, async (csms, cp) => {
          const root = await selfSignedRoot("01", "CPO Root");
          const sent = cp.sendSignCertificate();
          const sign = await csms.waitForCall("SignCertificate");
          await sent;
          csms.replyCallResult(sign.messageId, { status: "Accepted" });
          const { csr } = sign.payload as { csr: string };

          expect(
            await result(csms, "CertificateSigned", {
              certificateChain: await leafForCsr("02", csr, root),
            }),
          ).toEqual({ status: "Accepted" });
          expect(cp.certificateStore.listSignedChains()[0].use).toBe(
            "ChargingStationCertificate",
          );
        });
      });

      it("lists a V2G chain with its sub-CA as a child (M03.FR.05)", async () => {
        await withStation(version, async (csms, cp) => {
          const root = await selfSignedRoot("01", "V2G Root");
          const ca = await subCa("02", "V2G Sub-CA", root);
          const csr = await cp.certificateStore.generateNewCsr(
            cp.id,
            "Example CPO",
            undefined,
            "V2GCertificate",
          );
          const leaf = await leafForCsr("03", csr, ca);

          expect(
            await result(csms, "CertificateSigned", {
              certificateChain: `${leaf}\n${ca.pem}`,
              certificateType: "V2GCertificate",
            }),
          ).toEqual({ status: "Accepted" });

          const listed = await result(csms, "GetInstalledCertificateIds", {
            certificateType: ["V2GCertificateChain"],
          });
          expect(listed.status).toBe("Accepted");
          const [entry] = listed.certificateHashDataChain as HashDataChain[];
          expect(entry.certificateType).toBe("V2GCertificateChain");
          expect(entry.certificateHashData.serialNumber).toBe("3");
          expect(entry.childCertificateHashData).toHaveLength(1);
          expect(entry.childCertificateHashData?.[0].serialNumber).toBe("2");
        });
      });

      it("rejects a chain without a pending CSR and raises InvalidChargingStationCertificate (A02.FR.07)", async () => {
        await withStation(version, async (csms, cp) => {
          const root = await selfSignedRoot("01", "CPO Root");
          const { pem: strayCsr } = await generateCsr(cp.id, "Example CPO");
          const leaf = await leafForCsr("02", strayCsr, root);

          expect(
            await result(csms, "CertificateSigned", {
              certificateChain: leaf,
              certificateType: "ChargingStationCertificate",
            }),
          ).toEqual({ status: "Rejected" });
          expect(cp.certificateStore.listSignedChains()).toEqual([]);

          const event = await csms.waitForCall("SecurityEventNotification");
          expect(event.payload).toMatchObject({
            type: "InvalidChargingStationCertificate",
          });
          expect(
            typeof (event.payload as { timestamp?: unknown }).timestamp,
          ).toBe("string");
        });
      });

      it("keeps the CSR pending when the CSMS rejects SignCertificate", async () => {
        await withStation(version, async (csms, cp) => {
          const sent = cp.sendSignCertificate();
          const sign = await csms.waitForCall("SignCertificate");
          await sent;
          csms.replyCallResult(sign.messageId, { status: "Rejected" });
          // A sentinel CALL answered after the response proves it was read.
          expect(await result(csms, "GetInstalledCertificateIds", {})).toEqual({
            status: "NotFound",
          });
          expect(
            cp.certificateStore.pendingCsr("ChargingStationCertificate"),
          ).toBe((sign.payload as { csr: string }).csr);
        });
      });

      it("forwards a caller-supplied CSR and records it as pending", async () => {
        await withStation(version, async (csms, cp) => {
          const { pem } = await generateCsr(cp.id, "Example CPO");
          const sent = cp.sendSignCertificate(pem);
          const sign = await csms.waitForCall("SignCertificate");
          await sent;
          expect(sign.payload).toEqual({ csr: pem });
          expect(
            cp.certificateStore.pendingCsr("ChargingStationCertificate"),
          ).toBe(pem);
        });
      });

      it("keeps installed certificates across a restart with state persistence", async () => {
        const db = BunSqliteDatabase.open(":memory:");
        const id = `CP-PERSIST-${version}`;
        const root = await selfSignedRoot("0B", "Manufacturer Root");
        await withStation(
          version,
          async (csms) => {
            expect(
              await result(csms, "InstallCertificate", {
                certificateType: "ManufacturerRootCertificate",
                certificate: root.pem,
              }),
            ).toEqual({ status: "Accepted" });
          },
          db,
          id,
        );

        await withStation(
          version,
          async (csms) => {
            const listed = await result(csms, "GetInstalledCertificateIds", {
              certificateType: ["ManufacturerRootCertificate"],
            });
            expect(listed.status).toBe("Accepted");
            const chain = listed.certificateHashDataChain as HashDataChain[];
            expect(
              chain.map((c) => c.certificateHashData.serialNumber),
            ).toEqual(["b"]);
          },
          db,
          id,
        );
        db.close();
      });
    });

    describe("2.0.1 / 2.1 enum differences", () => {
      it("refuses OEMRootCertificate and V2G20Certificate on 2.0.1 by schema", async () => {
        await withStation("OCPP-2.0.1", async (csms) => {
          const root = await selfSignedRoot("01", "OEM Root");
          const install = await call(csms, "InstallCertificate", {
            certificateType: "OEMRootCertificate",
            certificate: root.pem,
          });
          expect(install[0]).toBe(4);
          expect(install[2]).toBe("FormatViolation");

          const query = await call(csms, "GetInstalledCertificateIds", {
            certificateType: ["OEMRootCertificate"],
          });
          expect(query[0]).toBe(4);
          expect(query[2]).toBe("FormatViolation");

          const signed = await call(csms, "CertificateSigned", {
            certificateChain: root.pem,
            certificateType: "V2G20Certificate",
          });
          expect(signed[0]).toBe(4);
          expect(signed[2]).toBe("FormatViolation");
        });
      });

      it("installs and lists OEMRootCertificate on 2.1; V2G20Certificate without a CSR is Rejected", async () => {
        await withStation("OCPP-2.1", async (csms, cp) => {
          const root = await selfSignedRoot("0C", "OEM Root");
          expect(
            await result(csms, "InstallCertificate", {
              certificateType: "OEMRootCertificate",
              certificate: root.pem,
            }),
          ).toEqual({ status: "Accepted" });
          expect(cp.certificateStore.listRootCertificates()[0].use).toBe(
            "OEMRootCertificate",
          );

          const listed = await result(csms, "GetInstalledCertificateIds", {
            certificateType: ["OEMRootCertificate"],
          });
          expect(
            (listed.certificateHashDataChain as HashDataChain[])[0]
              .certificateType,
          ).toBe("OEMRootCertificate");

          const { pem: strayCsr } = await generateCsr(cp.id, "Example CPO");
          expect(
            await result(csms, "CertificateSigned", {
              certificateChain: await leafForCsr("02", strayCsr, root),
              certificateType: "V2G20Certificate",
            }),
          ).toEqual({ status: "Rejected" });
        });
      });
    });
  },
);
