import { describe, it, expect, vi } from "vitest";
import { handleJsonCommand } from "../jsonMode";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import type { ChargePointService } from "../../data/interfaces/ChargePointService";
import type { FacadeSingleCpTarget } from "../singleCpTarget";

const BOOTSTRAP_CP_ID = "bootstrap-cp";

function facadeTarget(
  chargePointService: Partial<ChargePointService>,
): FacadeSingleCpTarget {
  return {
    chargePointService: chargePointService as ChargePointService,
    cpId: BOOTSTRAP_CP_ID,
  };
}

// run_scenario_template / load_scenario_template should accept an optional
// `evSettings` override so a connector's charging power (=> low-power
// eligibility) can be set without authoring a whole custom scenario — the
// template's own evSettings would otherwise clobber a prior set_ev_settings.
describe("(load|run)_scenario_template evSettings override", () => {
  it("routes run_scenario_template through the facade with the bootstrap cpId", async () => {
    const runScenarioTemplate = vi
      .fn()
      .mockResolvedValue({ scenarioId: "sid-1" });
    const service = facadeTarget({ runScenarioTemplate });

    const res = await handleJsonCommand(service, {
      command: "run_scenario_template",
      params: {
        connector: 1,
        templateId: "essential-cp-behavior",
        evSettings: { maxChargingPowerKw: 3 },
      },
    });

    expect(runScenarioTemplate).toHaveBeenCalledWith(
      BOOTSTRAP_CP_ID,
      "essential-cp-behavior",
      {
        connectorId: 1,
        evSettings: { maxChargingPowerKw: 3 },
      },
    );
    expect(res).toEqual({ scenarioId: "sid-1" });
  });

  it("routes load_scenario_template through the facade with evSettings", async () => {
    const loadScenarioTemplate = vi
      .fn()
      .mockResolvedValue({ scenarioId: "sid-2" });
    const service = facadeTarget({ loadScenarioTemplate });

    const res = await handleJsonCommand(service, {
      command: "load_scenario_template",
      params: {
        connector: 2,
        templateId: "full-charging-cycle",
        evSettings: { maxChargingPowerKw: 6 },
      },
    });

    expect(loadScenarioTemplate).toHaveBeenCalledWith(
      BOOTSTRAP_CP_ID,
      "full-charging-cycle",
      2,
      { maxChargingPowerKw: 6 },
    );
    expect(res).toEqual({ scenarioId: "sid-2" });
  });

  it("omits the override when no evSettings is given", async () => {
    const runScenarioTemplate = vi
      .fn()
      .mockResolvedValue({ scenarioId: "sid-3" });
    const service = facadeTarget({ runScenarioTemplate });

    await handleJsonCommand(service, {
      command: "run_scenario_template",
      params: { connector: 1, templateId: "smart-charging" },
    });

    expect(runScenarioTemplate).toHaveBeenCalledWith(
      BOOTSTRAP_CP_ID,
      "smart-charging",
      { connectorId: 1, evSettings: undefined },
    );
  });
});

describe("update_connector_status status notification options", () => {
  it("forwards all wire options through the facade with the bootstrap cpId", async () => {
    const sendStatusNotification = vi.fn().mockResolvedValue(undefined);
    const service = facadeTarget({ sendStatusNotification });

    await handleJsonCommand(service, {
      command: "update_connector_status",
      params: {
        connector: 1,
        status: "Faulted",
        errorCode: "EVCommunicationError",
        info: "pilot lost",
        vendorErrorCode: "E-42",
        vendorId: "Vendor",
        timestamp: "2026-01-02T03:04:05.000Z",
        suppressChargingStateTransactionEvent: true,
      },
    });

    expect(sendStatusNotification).toHaveBeenCalledTimes(1);
    const [cpId, connectorId, status, opts] =
      sendStatusNotification.mock.calls[0];
    expect(cpId).toBe(BOOTSTRAP_CP_ID);
    expect(connectorId).toBe(1);
    expect(status).toBe(OCPPStatus.Faulted);
    expect(opts).toMatchObject({
      errorCode: "EVCommunicationError",
      info: "pilot lost",
      vendorErrorCode: "E-42",
      vendorId: "Vendor",
      suppressChargingStateTransactionEvent: true,
    });
    expect(opts.timestamp).toBeInstanceOf(Date);
    expect(opts.timestamp.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("status command facade shape", () => {
  it("returns the legacy single-CP status shape from a facade snapshot", async () => {
    const service = facadeTarget({
      getChargePoint: vi.fn().mockResolvedValue({
        id: BOOTSTRAP_CP_ID,
        status: OCPPStatus.Available,
        error: "",
        connectors: [
          {
            id: 1,
            status: OCPPStatus.Available,
            availability: "Operative",
            meterValue: 123,
            transactionId: 99,
            soc: 80,
            mode: "manual",
            autoResetToAvailable: true,
            autoMeterValueConfig: null,
            evSettings: null,
            chargingProfile: null,
            chargingProfiles: [],
            transactionStartTime: new Date("2026-01-02T03:04:05.000Z"),
            transactionTagId: "TAG-1",
            transactionBatteryCapacityKwh: 50,
          },
        ],
        heartbeat: { intervalSeconds: 30, lastSentAt: null },
        config: {
          wsUrl: "ws://csms.example.test/ocpp",
          connectors: 1,
          vendor: "CLI-Vendor",
          model: "CLI-Model",
          basicAuth: null,
          bootNotification: null,
        },
      }),
    });

    await expect(
      handleJsonCommand(service, { command: "status" }),
    ).resolves.toEqual({
      id: BOOTSTRAP_CP_ID,
      status: OCPPStatus.Available,
      error: "",
      connectors: [
        {
          id: 1,
          status: OCPPStatus.Available,
          availability: "Operative",
          meterValue: 123,
          transactionId: 99,
          soc: 80,
          mode: "manual",
          autoResetToAvailable: true,
          autoMeterValueConfig: null,
          evSettings: null,
          chargingProfile: null,
          chargingProfiles: [],
          transactionStartTime: "2026-01-02T03:04:05.000Z",
          transactionTagId: "TAG-1",
          transactionBatteryCapacityKwh: 50,
        },
      ],
      heartbeat: { intervalSeconds: 30, lastSentAt: null },
      config: {
        wsUrl: "ws://csms.example.test/ocpp",
        connectors: 1,
        vendor: "CLI-Vendor",
        model: "CLI-Model",
        basicAuth: null,
        centralSystemUrl: undefined,
        soapCallbackUrl: undefined,
        soapPath: undefined,
        securityProfile: undefined,
        cpoName: undefined,
        tlsCaPath: undefined,
        tlsCertPath: undefined,
        tlsKeyPath: undefined,
        ocppVersion: undefined,
        bootNotification: null,
      },
    });
  });
});
