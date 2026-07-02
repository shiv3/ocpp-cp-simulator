import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { defaultEVSettings } from "../../cp/domain/connector/EVSettings";
import { useSocMeterSync } from "./useSocMeterSync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness({
  repository,
  service,
}: {
  repository: {
    loadSocMeterSync: () => Promise<boolean>;
    saveSocMeterSync: (enabled: boolean) => Promise<void>;
  };
  service: {
    setConnectorSocMeterSync: (
      cpId: string,
      connectorId: number,
      enabled: boolean,
    ) => Promise<void>;
  };
}) {
  const { autoSyncSocMeter, handleToggleAutoSync } = useSocMeterSync({
    chargePointService: service,
    connectorSettingsRepository: repository,
    cpId: "CP-1",
    connectorId: 1,
    evSettings: defaultEVSettings,
  });

  return (
    <label>
      <input
        type="checkbox"
        checked={autoSyncSocMeter}
        onChange={handleToggleAutoSync}
      />
      Sync SoC Meter
    </label>
  );
}

describe("useSocMeterSync", () => {
  it("does not let the async repository load overwrite a user toggle", async () => {
    const loaded = deferred<boolean>();
    const repository = {
      loadSocMeterSync: vi.fn(() => loaded.promise),
      saveSocMeterSync: vi.fn(() => Promise.resolve()),
    };
    const service = {
      setConnectorSocMeterSync: vi.fn(() => Promise.resolve()),
    };
    const user = userEvent.setup();

    render(<Harness repository={repository} service={service} />);

    const toggle = screen.getByRole("checkbox", {
      name: "Sync SoC Meter",
    });
    expect(toggle).toBeChecked();

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(repository.saveSocMeterSync).toHaveBeenCalledWith(false);

    await act(async () => {
      loaded.resolve(true);
      await loaded.promise;
    });

    expect(toggle).not.toBeChecked();
    expect(service.setConnectorSocMeterSync).toHaveBeenLastCalledWith(
      "CP-1",
      1,
      false,
    );
  });
});
