import { describe, expect, it } from "vitest";
import {
  CellularModem,
  ModemError,
  maskSimIdentifier,
  modemConfigProblem,
  type ModemChange,
} from "../CellularModem";
import { runModemCommand } from "../modemCommands";
import type { ModemRepository } from "../../persistence/ModemRepository";

class MemoryRepository implements ModemRepository {
  document: string | null = null;
  load() {
    return this.document;
  }
  save(document: string) {
    this.document = document;
  }
  delete() {
    this.document = null;
  }
}

const SIM = { iccid: "8944501234567890123", imsi: "310150123456789" };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof ModemError) return err.code;
    throw err;
  }
}

describe("CellularModem (#928)", () => {
  it("represents no modem, an empty slot and an inserted card distinctly", () => {
    const none = new CellularModem(
      "cp",
      { present: false },
      new MemoryRepository(),
    );
    const empty = new CellularModem("cp", {}, new MemoryRepository());
    const full = new CellularModem("cp", { sim: SIM }, new MemoryRepository());
    expect([none.slot, empty.slot, full.slot]).toEqual([
      "no_modem",
      "empty",
      "inserted",
    ]);
    expect(none.sim).toBeNull();
    expect(empty.sim).toBeNull();
    expect(full.sim).toMatchObject({ ...SIM, subscription: "active" });
  });

  it("defaults to ethernet so a SIM never disables a station by itself", () => {
    expect(
      new CellularModem("cp", { sim: SIM }, new MemoryRepository())
        .networkInterface,
    ).toBe("ethernet");
  });

  it("inserts, replaces and removes a card without recreating anything", () => {
    const modem = new CellularModem("cp", {}, new MemoryRepository());
    const changes: ModemChange[] = [];
    modem.onChange((c) => changes.push(c));
    const first = modem.insertSim(SIM);
    const second = modem.replaceSim({ iccid: "8900000000000000001" });
    expect(second.simId).not.toBe(first.simId);
    expect(second.imsi).toBeUndefined();
    modem.removeSim();
    expect(modem.slot).toBe("empty");
    expect(changes.map((c) => c.kind)).toEqual([
      "sim_inserted",
      "sim_replaced",
      "sim_removed",
    ]);
  });

  it("keeps ICCID/IMSI and the simId while the subscription is suspended", () => {
    const modem = new CellularModem("cp", { sim: SIM }, new MemoryRepository());
    const before = modem.sim!;
    const suspended = modem.suspendSubscription();
    expect(suspended).toEqual({ ...before, subscription: "suspended" });
    expect(modem.slot).toBe("inserted");
    expect(modem.activateSubscription()).toEqual(before);
  });

  it("rejects invalid transitions with typed errors and leaves the state alone", () => {
    const modem = new CellularModem("cp", {}, new MemoryRepository());
    expect(codeOf(() => modem.removeSim())).toBe("slot_empty");
    expect(codeOf(() => modem.replaceSim(SIM))).toBe("slot_empty");
    expect(codeOf(() => modem.suspendSubscription())).toBe("slot_empty");
    modem.insertSim(SIM);
    expect(codeOf(() => modem.insertSim(SIM))).toBe("slot_occupied");
    expect(codeOf(() => modem.activateSubscription())).toBe("already_active");
    modem.suspendSubscription();
    expect(codeOf(() => modem.suspendSubscription())).toBe("already_suspended");
    expect(codeOf(() => modem.replaceSim({ iccid: "has space" }))).toBe(
      "invalid_sim",
    );
    expect(modem.sim?.iccid).toBe(SIM.iccid);
    const noModem = new CellularModem(
      "cp",
      { present: false },
      new MemoryRepository(),
    );
    expect(codeOf(() => noModem.insertSim(SIM))).toBe("modem_absent");
    expect(codeOf(() => noModem.removeSim())).toBe("modem_absent");
  });

  it("persists across a restart; persisted state wins over the configuration", () => {
    const repository = new MemoryRepository();
    const first = new CellularModem(
      "cp",
      { sim: SIM, networkInterface: "cellular" },
      repository,
    );
    first.suspendSubscription();
    first.replaceSim({
      iccid: "8900000000000000002",
      subscription: "suspended",
    });
    const restored = new CellularModem("cp", { sim: SIM }, repository);
    expect(restored.sim).toMatchObject({
      iccid: "8900000000000000002",
      subscription: "suspended",
    });
    expect(restored.networkInterface).toBe("cellular");
    // the card counter survives: no simId is reused
    expect(restored.replaceSim(SIM).simId).toBe("cp-sim-3");
    expect(CellularModem.restore("cp", repository)?.sim?.iccid).toBe(SIM.iccid);
  });

  it("restore finds nothing without a document and ignores a corrupt one", () => {
    const repository = new MemoryRepository();
    expect(CellularModem.restore("cp", repository)).toBeNull();
    repository.document = "{nope";
    expect(CellularModem.restore("cp", repository)).toBeNull();
    // a corrupt row under an explicit config falls back to that config
    expect(new CellularModem("cp", { sim: SIM }, repository).slot).toBe(
      "inserted",
    );
  });

  it("masks identifiers on every read surface", () => {
    expect(maskSimIdentifier("8944501234567890123")).toBe(
      "***************0123",
    );
    expect(maskSimIdentifier("123")).toBe("***");
    expect(maskSimIdentifier(undefined)).toBeNull();
    const modem = new CellularModem("cp", { sim: SIM }, new MemoryRepository());
    const redacted = JSON.stringify(modem.redacted());
    expect(redacted).not.toContain(SIM.iccid);
    expect(redacted).not.toContain(SIM.imsi);
  });

  it("validates configuration", () => {
    expect(modemConfigProblem({ sim: { iccid: "x".repeat(21) } })).toMatch(
      /iccid/,
    );
    expect(modemConfigProblem({ present: false, sim: SIM })).toMatch(
      /needs a modem/,
    );
    expect(modemConfigProblem({ networkInterface: "5g" })).toMatch(
      /networkInterface/,
    );
    expect(modemConfigProblem({ bogus: 1 })).toMatch(/unknown field/);
    expect(
      modemConfigProblem({ sim: SIM, networkInterface: "wifi" }),
    ).toBeNull();
  });
});

describe("runModemCommand", () => {
  it("answers no_modem_model for a station without the model", () => {
    expect(runModemCommand(null, { command: "remove_sim" })).toEqual({
      ok: false,
      error: "no_modem_model",
    });
  });

  it("answers the typed code of a refused transition and the masked state on success", () => {
    const modem = new CellularModem("cp", {}, new MemoryRepository());
    expect(runModemCommand(modem, { command: "remove_sim" })).toEqual({
      ok: false,
      error: "slot_empty",
    });
    const ok = runModemCommand(modem, { command: "insert_sim", sim: SIM });
    expect(ok.ok).toBe(true);
    expect(JSON.stringify(ok)).not.toContain(SIM.iccid);
    expect(
      runModemCommand(modem, {
        command: "set_network_interface",
        networkInterface: "cellular",
      }),
    ).toMatchObject({ ok: true, modem: { networkInterface: "cellular" } });
  });
});
