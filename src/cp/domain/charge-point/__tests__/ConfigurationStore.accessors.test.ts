import { describe, expect, it } from "vitest";
import {
  ConfigurationKeys,
  ConfigurationStore,
  type ConfigurationValue,
} from "../ConfigurationStore";

function emptyStore(): ConfigurationStore {
  return new ConfigurationStore("cp-test", [], null);
}

function storeWith(...entries: ConfigurationValue[]): ConfigurationStore {
  return new ConfigurationStore("cp-test", entries, null);
}

describe("ConfigurationStore semantic accessors", () => {
  it("returns documented defaults when keys are absent", () => {
    const store = emptyStore();

    const firstSampledData = store.meterValuesSampledData();
    const secondSampledData = store.meterValuesSampledData();
    expect(firstSampledData).toEqual(["Energy.Active.Import.Register"]);
    expect(secondSampledData).toEqual(["Energy.Active.Import.Register"]);
    expect(firstSampledData).not.toBe(secondSampledData);

    expect(store.transactionMessageAttempts()).toBe(3);
    expect(store.authorizeRemoteTxRequests()).toBe(false);
    expect(store.localAuthListEnabled()).toBe(true);
    expect(store.localAuthListMaxLength()).toBe(1000);
    expect(store.sendLocalListMaxLength()).toBe(100);
    expect(store.connectionTimeOut()).toBe(60);
  });

  it("returns configured values when keys are present", () => {
    const sampledData = ["Voltage", "Current.Import"];
    const store = storeWith(
      {
        key: ConfigurationKeys.Core.MeterValuesSampledData,
        value: sampledData,
      },
      {
        key: ConfigurationKeys.Core.TransactionMessageAttempts,
        value: 7,
      },
      {
        key: ConfigurationKeys.Core.AuthorizeRemoteTxRequests,
        value: true,
      },
      {
        key: ConfigurationKeys.LocalAuthListManagement.LocalAuthListEnabled,
        value: false,
      },
      {
        key: ConfigurationKeys.LocalAuthListManagement.LocalAuthListMaxLength,
        value: 42,
      },
      {
        key: ConfigurationKeys.LocalAuthListManagement.SendLocalListMaxLength,
        value: 24,
      },
      {
        key: ConfigurationKeys.Core.ConnectionTimeOut,
        value: 9,
      },
    );

    expect(store.meterValuesSampledData()).toBe(sampledData);
    expect(store.transactionMessageAttempts()).toBe(7);
    expect(store.authorizeRemoteTxRequests()).toBe(true);
    expect(store.localAuthListEnabled()).toBe(false);
    expect(store.localAuthListMaxLength()).toBe(42);
    expect(store.sendLocalListMaxLength()).toBe(24);
    expect(store.connectionTimeOut()).toBe(9);
  });
});
