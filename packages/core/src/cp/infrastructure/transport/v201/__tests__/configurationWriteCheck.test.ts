import { describe, expect, it } from "vitest";

import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { defaultConfiguration } from "../../../../domain/charge-point/Configuration";
import { ConfigurationStore } from "../../../../domain/charge-point/ConfigurationStore";
import {
  ConfigurationWriteRejectedError,
  writeConfigurationKey,
} from "../../../../domain/charge-point/configurationAccess";
import { configurationWriteCheckV201 } from "../setVariablesV201";

const VERSION = "OCPP-2.0.1";

function store(): ConfigurationStore {
  return new ConfigurationStore(
    defaultConfiguration({
      connectorNumber: 1,
      wsUrl: "ws://csms.example/ocpp/",
      ocppVersion: VERSION,
    } as ChargePoint),
  );
}

const write = (s: ConfigurationStore, key: string, value: string) =>
  writeConfigurationKey(
    s,
    true,
    key,
    value,
    undefined,
    configurationWriteCheckV201(VERSION),
  );

describe("cp.config_keys.set on 2.x runs the SetVariables value checks", () => {
  it("refuses a measurand outside MeasurandEnumType and keeps the list", () => {
    const s = store();
    const before = s.get("MeterValuesSampledData")?.value;
    expect(() => write(s, "MeterValuesSampledData", "Temperature,Foo")).toThrow(
      ConfigurationWriteRejectedError,
    );
    expect(s.get("MeterValuesSampledData")?.value).toEqual(before);
  });

  it("refuses a value that is not an integer for an integer variable", () => {
    expect(() => write(store(), "HeartbeatInterval", "1e3")).toThrow(
      ConfigurationWriteRejectedError,
    );
  });

  it("writes a valid value", () => {
    const s = store();
    expect(
      write(s, "MeterValuesSampledData", "Energy.Active.Import.Register"),
    ).toBe("Accepted");
    expect(write(s, "HeartbeatInterval", "90")).toBe("Accepted");
    expect(s.getInteger("HeartbeatInterval")).toBe(90);
  });
});
