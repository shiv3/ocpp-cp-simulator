import { describe, expect, it } from "vitest";
import { CellularModem, type ModemConfig } from "../CellularModem";
import {
  bootNotificationFor,
  projectBootIdentifiers,
} from "../bootIdentifiers";
import { runModemCommand } from "../modemCommands";
import { NoopModemRepository } from "../../persistence/ModemRepository";
import {
  DefaultBootNotification,
  type BootNotification,
} from "../../types/OcppTypes";

const SIM = { iccid: "8944501234567890123", imsi: "310150123456789" };
const modem = (config: ModemConfig) =>
  new CellularModem("cp", config, new NoopModemRepository());
const LEGACY: BootNotification = {
  ...DefaultBootNotification,
  iccid: "STATIC-ICCID",
  imsi: "STATIC-IMSI",
};

describe("bootNotificationFor (#929)", () => {
  it("returns the very same object without a modem model: legacy bytes stay", () => {
    expect(bootNotificationFor(LEGACY, null)).toBe(LEGACY);
    expect(
      JSON.stringify(bootNotificationFor(DefaultBootNotification, null)),
    ).toBe(JSON.stringify(DefaultBootNotification));
  });

  it("takes the identifiers from the card and ignores the static ones", () => {
    const out = bootNotificationFor(LEGACY, modem({ sim: SIM }));
    expect(out.iccid).toBe(SIM.iccid);
    expect(out.imsi).toBe(SIM.imsi);
    expect(JSON.stringify(out)).not.toContain("STATIC");
  });

  it("omits the fields with no modem, an empty slot or policy none", () => {
    for (const config of [
      { present: false },
      {},
      { reporting: "none", sim: SIM },
    ] as ModemConfig[]) {
      const out = bootNotificationFor(LEGACY, modem(config));
      expect("iccid" in out).toBe(false);
      expect("imsi" in out).toBe(false);
    }
  });

  it("reports the ICCID only under policy iccid", () => {
    const out = bootNotificationFor(
      LEGACY,
      modem({ reporting: "iccid", sim: SIM }),
    );
    expect(out.iccid).toBe(SIM.iccid);
    expect("imsi" in out).toBe(false);
  });

  it("never fabricates an identifier the card lacks", () => {
    expect(
      projectBootIdentifiers(modem({ sim: { iccid: SIM.iccid } })),
    ).toEqual({ iccid: SIM.iccid });
    expect(projectBootIdentifiers(modem({ sim: { imsi: SIM.imsi } }))).toEqual({
      imsi: SIM.imsi,
    });
  });

  it("does not depend on the subscription state", () => {
    const m = modem({ sim: SIM });
    const before = projectBootIdentifiers(m);
    m.suspendSubscription();
    expect(projectBootIdentifiers(m)).toEqual(before);
    m.activateSubscription();
    expect(projectBootIdentifiers(m)).toEqual(before);
  });

  it("follows a swap and a policy change on the next payload", () => {
    const m = modem({ sim: SIM });
    m.replaceSim({ iccid: "8900000000000000002" });
    expect(bootNotificationFor(LEGACY, m).iccid).toBe("8900000000000000002");
    expect("imsi" in bootNotificationFor(LEGACY, m)).toBe(false);
    m.removeSim();
    expect("iccid" in bootNotificationFor(LEGACY, m)).toBe(false);
  });
});

describe("set_reporting_policy", () => {
  it("changes the policy and refuses an unknown one with a typed error", () => {
    const m = modem({ sim: SIM });
    expect(
      runModemCommand(m, {
        command: "set_reporting_policy",
        reporting: "none",
      }),
    ).toMatchObject({ ok: true, modem: { reporting: "none" } });
    expect(m.reporting).toBe("none");
    expect(
      runModemCommand(m, {
        command: "set_reporting_policy",
        reporting: "all" as never,
      }),
    ).toEqual({ ok: false, error: "invalid_reporting_policy" });
  });
});
