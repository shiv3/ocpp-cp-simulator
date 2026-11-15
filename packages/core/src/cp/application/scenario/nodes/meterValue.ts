import type {
  MeterValueNodeData,
  ScenarioExecutorCallbacks,
} from "../ScenarioTypes";
import type { BranchScope } from "../branchScope";
import type { NodeRunContext } from "./context";

type AutoMeterStartConfig = Parameters<
  NonNullable<ScenarioExecutorCallbacks["onStartAutoMeterValue"]>
>[0] & { sendMessage?: boolean };
type MeterValueCallbacks = ScenarioExecutorCallbacks & {
  onGetTransactionMeterStart?: () => number | null;
};

const isMeterValueTimeout = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.startsWith("Timeout waiting for meter value:");

/**
 * Execute meter value node with auto-increment support
 */
export async function executeMeterValue(
  ctx: NodeRunContext,
  nodeId: string,
  data: MeterValueNodeData,
  scope: BranchScope,
): Promise<void> {
  const meterCallbacks = ctx.callbacks as MeterValueCallbacks;
  const currentBeforeSeed = ctx.callbacks.onGetMeterValue?.();
  let seededValue = currentBeforeSeed ?? data.value;
  if (ctx.callbacks.onSetMeterValue) {
    // Daemon-restart resume case: the persisted connector_runtime row
    // restored a non-zero meter accumulator (e.g. 624 Wh from a charge
    // that was interrupted), and now the scenario walks back into the
    // meterValue node whose `data.value` is the node's *initial seed*
    // (commonly 0). Writing that seed would erase the accumulator and
    // restart the maxValue cap from scratch. Skip the seed write when
    // the connector already holds more.
    if (currentBeforeSeed == null || currentBeforeSeed <= data.value) {
      ctx.callbacks.onSetMeterValue(data.value);
      seededValue = data.value;
    } else {
      seededValue = currentBeforeSeed;
      ctx.callbacks.log?.(
        `[${ctx.scenario.name}] Preserving meter accumulator ${currentBeforeSeed}Wh (> node seed ${data.value}Wh) on resume`,
        "info",
      );
    }
  }

  // Handle auto-increment mode - start AutoMeterValue manager
  if (data.autoIncrement && ctx.callbacks.onStartAutoMeterValue) {
    // Resolve the stop conditions. Default is "manual" for back-compat,
    // which reads the node's maxTime / maxValue. "evSettings" derives a
    // maxValue from the connector's EV settings (capacity × ΔSoC).
    let resolvedMaxTime: number | undefined = data.maxTime;
    let resolvedMaxValue: number | undefined =
      data.maxValue ??
      (data.maxChargeKwh != null
        ? Math.round(data.maxChargeKwh * 1000)
        : undefined);

    if (data.stopMode === "evSettings") {
      const settings = ctx.callbacks.onGetEVSettings?.() ?? null;
      if (settings && settings.batteryCapacityKwh > 0) {
        const delta = Math.max(
          0,
          (settings.targetSoc ?? 0) - (settings.initialSoc ?? 0),
        );
        if (delta <= 0) {
          ctx.callbacks.log?.(
            `[${ctx.scenario.name}] stopMode=evSettings target already reached; auto-meter completes without starting`,
            "info",
          );
          return;
        }
        // Wh delivered to move from initialSoc% to targetSoc% on a
        // capacity-kWh battery: capacity_kWh × (Δ%/100) × 1000 Wh/kWh
        resolvedMaxValue = Math.round(settings.batteryCapacityKwh * delta * 10);
        resolvedMaxTime = undefined; // EV-driven runs are value-bounded only
        ctx.callbacks.log?.(
          `[${ctx.scenario.name}] stopMode=evSettings → maxValue=${resolvedMaxValue}Wh ` +
            `(capacity=${settings.batteryCapacityKwh}kWh, ` +
            `${settings.initialSoc ?? 0}% → ${settings.targetSoc ?? 0}%)`,
          "info",
        );
      } else {
        ctx.callbacks.log?.(
          `[${ctx.scenario.name}] stopMode=evSettings but EV settings unavailable; auto-meter will run unbounded`,
          "warn",
        );
        resolvedMaxValue = undefined;
        resolvedMaxTime = undefined;
      }
    } else {
      ctx.callbacks.log?.(
        `[${ctx.scenario.name}] Starting AutoMeterValue: interval=${data.incrementInterval || 10}s increment=${data.incrementAmount || 1000}Wh maxTime=${resolvedMaxTime || "unlimited"} maxValue=${resolvedMaxValue || "unlimited"}`,
        "info",
      );
    }

    const meterStart =
      meterCallbacks.onGetTransactionMeterStart?.() ?? seededValue;
    const resolvedMaxMeterValue =
      resolvedMaxValue && resolvedMaxValue > 0
        ? meterStart + resolvedMaxValue
        : undefined;
    const autoMeterConfig: AutoMeterStartConfig = {
      intervalSeconds: data.incrementInterval || 10,
      incrementValue: data.incrementAmount || 1000,
      maxTimeSeconds: resolvedMaxTime,
      maxValue: resolvedMaxMeterValue,
      sendMessage: data.sendMessage,
    };

    ctx.callbacks.onStartAutoMeterValue(autoMeterConfig);

    if (resolvedMaxMeterValue && resolvedMaxMeterValue > 0) {
      try {
        await ctx.waitWithOptionalForceSkip(
          ctx.callbacks.onWaitForMeterValue?.(
            resolvedMaxMeterValue,
            resolvedMaxTime,
          ) ??
            (resolvedMaxTime && resolvedMaxTime > 0
              ? ctx.sleep(resolvedMaxTime * 1000, scope)
              : Promise.resolve()),
          scope,
        );
      } catch (error) {
        if (!resolvedMaxTime || !isMeterValueTimeout(error)) {
          throw error;
        }
      }
      ctx.callbacks.onStopAutoMeterValue?.();
    } else if (resolvedMaxTime && resolvedMaxTime > 0) {
      await ctx.waitWithProgress(nodeId, resolvedMaxTime, scope);
      ctx.callbacks.onStopAutoMeterValue?.();
    }
  }

  if (
    !data.autoIncrement &&
    data.sendMessage &&
    ctx.callbacks.onSendMeterValue
  ) {
    await ctx.callbacks.onSendMeterValue();
  }
}
