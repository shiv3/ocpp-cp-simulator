import React, { Suspense, lazy, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  defaultAutoMeterValueConfig,
  type AutoMeterValueConfig,
} from "@/cp/domain/connector/MeterValueCurve";
import { useDataContext } from "@/data/providers/DataProvider";

const MeterValueCurveModal = lazy(
  () => import("@/components/MeterValueCurveModal"),
);

export interface AutoMeterButtonProps {
  cpId: string;
  connectorId: number;
  /** The connector's live configuration, when it reports one. */
  liveConfig: AutoMeterValueConfig | null;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Edits one connector's auto meter values (enabled, interval, energy curve)
 * in the shared curve editor. The editor opens on the live configuration,
 * else the one saved for the connector, else the default. Saving applies it
 * to the connector (a running transaction picks it up at once) and stores it
 * for the connector.
 */
const AutoMeterButton: React.FC<AutoMeterButtonProps> = ({
  cpId,
  connectorId,
  liveConfig,
}) => {
  const { chargePointService } = useDataContext();
  const [initialConfig, setInitialConfig] =
    useState<AutoMeterValueConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setError(null);
    let saved: AutoMeterValueConfig | null = null;
    if (!liveConfig) {
      try {
        saved = await chargePointService.getAutoMeterConfig(cpId, connectorId);
      } catch (err) {
        // Not "nothing saved": opening on the default here could overwrite
        // a configuration that only failed to load.
        console.error(
          `Failed to read the auto meter values saved for ${cpId}/${connectorId}`,
          err,
        );
        setError(`Saved auto meter values not read: ${describeError(err)}`);
        return;
      }
    }
    setInitialConfig(liveConfig ?? saved ?? defaultAutoMeterValueConfig);
  };

  // Two steps, reported apart: a curve can be live on the connector and yet
  // not stored.
  const save = async (config: AutoMeterValueConfig) => {
    try {
      await chargePointService.setAutoMeterValueConfig(
        cpId,
        connectorId,
        config,
      );
    } catch (err) {
      console.error(
        `Failed to apply auto meter values on ${cpId}/${connectorId}`,
        err,
      );
      setError(`Auto meter values not applied: ${describeError(err)}`);
      return;
    }
    try {
      await chargePointService.saveAutoMeterConfig(cpId, connectorId, config);
    } catch (err) {
      console.error(
        `Failed to save auto meter values for ${cpId}/${connectorId}`,
        err,
      );
      setError(
        `Auto meter values applied, but not saved: ${describeError(err)}`,
      );
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full text-xs"
        onClick={() => void open()}
      >
        Auto meter values
      </Button>
      {error && (
        <p role="alert" className="text-xs text-cx-rose">
          {error}
        </p>
      )}
      {initialConfig && (
        <Suspense fallback={null}>
          <MeterValueCurveModal
            isOpen
            initialConfig={initialConfig}
            onClose={() => setInitialConfig(null)}
            onSave={(config) => void save(config)}
          />
        </Suspense>
      )}
    </>
  );
};

export default AutoMeterButton;
