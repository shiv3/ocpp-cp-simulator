import React, { useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import {
  type NetworkSimLayerConfig,
  type NetworkSimRule,
  NETWORK_SIM_LIMITS,
} from "../../../cp/infrastructure/transport/network-sim/config";
import {
  type RuleFormEntry,
  type LayerFormState,
  type CpLayerFormState,
  type CpRuleFormEntry,
  layerConfigToForm,
  formToLayerConfig,
  cpLayerToForm,
  formToCpLayer,
} from "./ruleFormState";

type NetworkSimEditorProps =
  | {
      mode: "global";
      value: NetworkSimLayerConfig | null;
      onSave: (config: NetworkSimLayerConfig | null) => Promise<void>;
    }
  | {
      mode: "cp";
      value: NetworkSimLayerConfig | null;
      inheritedRules: Record<string, NetworkSimRule>;
      inheritedEnabled: boolean;
      onSave: (config: NetworkSimLayerConfig | null) => Promise<void>;
      onDeleteOverride: () => Promise<void>;
    };

export const NetworkSimEditor: React.FC<NetworkSimEditorProps> = (props) => {
  const isGlobalMode = props.mode === "global";

  const [globalForm, setGlobalForm] = useState<LayerFormState | null>(null);
  const [cpForm, setCpForm] = useState<CpLayerFormState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isDeletingOverride, setIsDeletingOverride] = useState(false);

  // Initialize form based on mode
  React.useEffect(() => {
    if (isGlobalMode) {
      setGlobalForm(layerConfigToForm(props.value));
    } else if ("inheritedRules" in props) {
      setCpForm(cpLayerToForm(props.value, props.inheritedRules));
    }
  }, [props, isGlobalMode]);

  const handleSave = async () => {
    if (isGlobalMode && globalForm) {
      const result = formToLayerConfig(globalForm);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }

      setErrors({});
      setIsSaving(true);
      setSaveError(null);
      try {
        await props.onSave(result.config);
      } catch (error) {
        setSaveError(
          error instanceof Error
            ? error.message
            : "Failed to save configuration",
        );
      } finally {
        setIsSaving(false);
      }
    } else if (!isGlobalMode && cpForm && props.mode === "cp") {
      const result = formToCpLayer(cpForm);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }

      setErrors({});
      setIsSaving(true);
      setSaveError(null);
      try {
        await props.onSave(result.config);
      } catch (error) {
        setSaveError(
          error instanceof Error
            ? error.message
            : "Failed to save configuration",
        );
      } finally {
        setIsSaving(false);
      }
    }
  };

  const handleDeleteOverride = async () => {
    if (props.mode !== "cp") {
      return;
    }
    setIsDeletingOverride(true);
    setSaveError(null);
    try {
      await props.onDeleteOverride();
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Failed to delete override",
      );
    } finally {
      setIsDeletingOverride(false);
    }
  };

  const addRule = () => {
    if (isGlobalMode && globalForm) {
      const newRule: RuleFormEntry = {
        id: `rule-${Date.now()}`,
        type: "latency",
        delayMs: 0,
      };
      setGlobalForm((prev) => ({
        ...prev!,
        rules: [...prev!.rules, newRule],
      }));
    } else if (!isGlobalMode && cpForm) {
      const newRule: CpRuleFormEntry = {
        id: `rule-${Date.now()}`,
        type: "latency",
        delayMs: 0,
        classification: "local",
      };
      setCpForm((prev) => ({
        ...prev!,
        rules: [...prev!.rules, newRule],
      }));
    }
  };

  const removeRule = (index: number) => {
    if (isGlobalMode && globalForm) {
      setGlobalForm((prev) => ({
        ...prev!,
        rules: prev!.rules.filter((_, i) => i !== index),
      }));
    } else if (!isGlobalMode && cpForm) {
      setCpForm((prev) => ({
        ...prev!,
        rules: prev!.rules.filter((_, i) => i !== index),
      }));
    }
  };

  const updateRule = (
    index: number,
    updates: Partial<RuleFormEntry | CpRuleFormEntry>,
  ) => {
    if (isGlobalMode && globalForm) {
      setGlobalForm((prev) => ({
        ...prev!,
        rules: prev!.rules.map((r, i) =>
          i === index ? { ...r, ...updates } : r,
        ),
      }));
    } else if (!isGlobalMode && cpForm) {
      setCpForm((prev) => ({
        ...prev!,
        rules: prev!.rules.map((r, i) =>
          i === index ? { ...r, ...updates } : r,
        ),
      }));
    }
  };

  const updateSeed = (seedStr: string) => {
    if (isGlobalMode && globalForm) {
      setGlobalForm((prev) => ({ ...prev!, seed: seedStr }));
    } else if (!isGlobalMode && cpForm) {
      setCpForm((prev) => ({ ...prev!, seed: seedStr }));
    }
  };

  const updateEnabled = (enabled: boolean | undefined) => {
    if (isGlobalMode && globalForm) {
      setGlobalForm((prev) => ({ ...prev!, enabled: enabled ?? false }));
    } else if (!isGlobalMode && cpForm) {
      setCpForm((prev) => ({ ...prev!, enabled }));
    }
  };

  const hasError = Object.keys(errors).length > 0;
  const form = isGlobalMode ? globalForm : cpForm;
  const rules = form?.rules ?? [];

  if (!form) {
    return (
      <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
          Network simulation rules apply to WebSocket charge points only. SOAP
          CPs are unaffected.
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
        <div className="space-y-4">
          {isGlobalMode ? (
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="network-sim-enabled"
                checked={form.enabled}
                onChange={(e) => updateEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600"
              />
              <label
                htmlFor="network-sim-enabled"
                className="text-sm font-medium text-gray-700 dark:text-gray-200"
              >
                Enable network simulation
              </label>
            </div>
          ) : (
            <TriStateEnabledControl
              enabled={form.enabled}
              inheritedEnabled={props.inheritedEnabled}
              onChange={updateEnabled}
            />
          )}

          {isGlobalMode && (
            <div>
              <label
                htmlFor="network-sim-seed"
                className="block text-sm font-medium text-gray-700 dark:text-gray-200"
              >
                Seed
              </label>
              <input
                id="network-sim-seed"
                type="text"
                value={form.seed}
                onChange={(e) => updateSeed(e.target.value)}
                placeholder="1"
                className={`mt-1 block w-full rounded-md border px-3 py-2 text-sm placeholder-gray-400 transition ${
                  errors["seed"]
                    ? "border-red-500 bg-red-50 focus:outline-none focus:ring-1 focus:ring-red-500 dark:border-red-500 dark:bg-red-950"
                    : "border-gray-300 bg-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800"
                }`}
              />
              {errors["seed"] && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {errors["seed"]}
                </p>
              )}
            </div>
          )}

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                Rules ({rules.length}/{NETWORK_SIM_LIMITS.maxRulesPerLayer})
              </h3>
              <button
                type="button"
                onClick={addRule}
                disabled={rules.length >= NETWORK_SIM_LIMITS.maxRulesPerLayer}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed dark:hover:bg-blue-700"
              >
                <Plus className="h-3.5 w-3.5" />
                {isGlobalMode ? "Add Rule" : "Add Local Rule"}
              </button>
            </div>

            {errors["rules"] && (
              <p className="mb-3 text-xs text-red-600 dark:text-red-400">
                {errors["rules"]}
              </p>
            )}

            <div className="space-y-3">
              {rules.map((rule, index) => (
                <RuleEditor
                  key={`${rule.id}-${index}`}
                  rule={rule}
                  index={index}
                  errors={errors}
                  onUpdate={(updates) => updateRule(index, updates)}
                  onRemove={() => removeRule(index)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {saveError && (
        <div className="rounded-md border border-red-500 bg-red-50 p-3 text-sm text-red-600 dark:border-red-500 dark:bg-red-950 dark:text-red-400">
          {saveError}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || hasError}
          className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white transition ${
            isSaving || hasError
              ? "bg-gray-400 cursor-not-allowed dark:bg-gray-600"
              : "bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700"
          }`}
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
        {!isGlobalMode && (
          <button
            type="button"
            onClick={handleDeleteOverride}
            disabled={isDeletingOverride || isSaving}
            className="inline-flex items-center gap-2 rounded-md border border-red-600 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:border-gray-400 disabled:text-gray-400 disabled:cursor-not-allowed dark:border-red-500 dark:text-red-400 dark:hover:bg-red-950"
          >
            {isDeletingOverride ? "Deleting…" : "Delete per-CP override"}
          </button>
        )}
      </div>
    </div>
  );
};

interface TriStateEnabledControlProps {
  enabled: boolean | undefined;
  inheritedEnabled: boolean;
  onChange: (enabled: boolean | undefined) => void;
}

const TriStateEnabledControl: React.FC<TriStateEnabledControlProps> = ({
  enabled,
  inheritedEnabled,
  onChange,
}) => {
  const options: Array<{
    label: string;
    value: boolean | undefined;
  }> = [
    {
      label: `Inherit (${inheritedEnabled ? "on" : "off"})`,
      value: undefined,
    },
    { label: "On", value: true },
    { label: "Off", value: false },
  ];

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
        Enable network simulation
      </label>
      <div className="flex gap-2">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => onChange(option.value)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              enabled === option.value
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
};

interface RuleEditorProps {
  rule: RuleFormEntry;
  index: number;
  errors: Record<string, string>;
  onUpdate: (updates: Partial<RuleFormEntry>) => void;
  onRemove: () => void;
}

const RuleEditor: React.FC<RuleEditorProps> = ({
  rule,
  index,
  errors,
  onUpdate,
  onRemove,
}) => {
  const prefix = `rules.${index}`;
  const getError = (field: string) => errors[`${prefix}.${field}`];

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
            Rule ID
          </label>
          <input
            type="text"
            value={rule.id}
            onChange={(e) => onUpdate({ id: e.target.value })}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-xs transition ${
              getError("id")
                ? "border-red-500 bg-red-50 focus:outline-none focus:ring-1 focus:ring-red-500 dark:border-red-500 dark:bg-red-950"
                : "border-gray-300 bg-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
            }`}
          />
          {getError("id") && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              {getError("id")}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="mt-6 rounded-md p-1.5 text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/30"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-4">
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
          Type
        </label>
        <select
          value={rule.type}
          onChange={(e) =>
            onUpdate({
              type: e.target.value as RuleFormEntry["type"],
              // Reset type-specific fields
              direction: undefined,
              actions: undefined,
              delayMs: undefined,
              jitterMs: undefined,
              reconnectDelayMs: undefined,
              intervalMs: undefined,
              intervalJitterMs: undefined,
            })
          }
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
        >
          <option value="latency">Latency</option>
          <option value="manual-disconnect">Manual Disconnect</option>
          <option value="periodic-disconnect">Periodic Disconnect</option>
        </select>
      </div>

      <div className="space-y-3">
        {rule.type === "latency" && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                Direction (optional)
              </label>
              <select
                value={rule.direction || ""}
                onChange={(e) =>
                  onUpdate({
                    direction: e.target.value
                      ? (e.target.value as RuleFormEntry["direction"])
                      : undefined,
                  })
                }
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
              >
                <option value="">Not set</option>
                <option value="upstream">Upstream</option>
                <option value="downstream">Downstream</option>
                <option value="both">Both</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                Actions (optional, comma-separated)
              </label>
              <textarea
                value={rule.actions || ""}
                onChange={(e) => onUpdate({ actions: e.target.value })}
                placeholder="BootNotification, StatusNotification"
                rows={2}
                className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-xs placeholder-gray-400 transition ${
                  getError("actions")
                    ? "border-red-500 bg-red-50 focus:outline-none focus:ring-1 focus:ring-red-500 dark:border-red-500 dark:bg-red-950"
                    : "border-gray-300 bg-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                }`}
              />
              {getError("actions") && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {getError("actions")}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Delay (ms)
                </label>
                <input
                  type="number"
                  value={rule.delayMs ?? ""}
                  onChange={(e) =>
                    onUpdate({
                      delayMs:
                        e.target.value === ""
                          ? undefined
                          : parseInt(e.target.value, 10),
                    })
                  }
                  min="0"
                  max={NETWORK_SIM_LIMITS.maxDelayMs}
                  className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-xs transition ${
                    getError("delayMs")
                      ? "border-red-500 bg-red-50 focus:outline-none focus:ring-1 focus:ring-red-500 dark:border-red-500 dark:bg-red-950"
                      : "border-gray-300 bg-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                  }`}
                />
                {getError("delayMs") && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {getError("delayMs")}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Jitter (ms, optional)
                </label>
                <input
                  type="number"
                  value={rule.jitterMs ?? ""}
                  onChange={(e) =>
                    onUpdate({
                      jitterMs:
                        e.target.value === ""
                          ? undefined
                          : parseInt(e.target.value, 10),
                    })
                  }
                  min="0"
                  max={NETWORK_SIM_LIMITS.maxDelayMs}
                  className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-xs transition ${
                    getError("jitterMs")
                      ? "border-red-500 bg-red-50 focus:outline-none focus:ring-1 focus:ring-red-500 dark:border-red-500 dark:bg-red-950"
                      : "border-gray-300 bg-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                  }`}
                />
                {getError("jitterMs") && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {getError("jitterMs")}
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        {rule.type === "manual-disconnect" && (
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
              Reconnect Delay (ms)
            </label>
            <input
              type="number"
              value={rule.reconnectDelayMs ?? ""}
              onChange={(e) =>
                onUpdate({
                  reconnectDelayMs:
                    e.target.value === ""
                      ? undefined
                      : parseInt(e.target.value, 10),
                })
              }
              min="0"
              max={NETWORK_SIM_LIMITS.maxDelayMs}
              className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-xs transition ${
                getError("reconnectDelayMs")
                  ? "border-red-500 bg-red-50 focus:outline-none focus:ring-1 focus:ring-red-500 dark:border-red-500 dark:bg-red-950"
                  : "border-gray-300 bg-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
              }`}
            />
            {getError("reconnectDelayMs") && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {getError("reconnectDelayMs")}
              </p>
            )}
          </div>
        )}

        {rule.type === "periodic-disconnect" && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                Interval (ms)
              </label>
              <input
                type="number"
                value={rule.intervalMs ?? ""}
                onChange={(e) =>
                  onUpdate({
                    intervalMs:
                      e.target.value === ""
                        ? undefined
                        : parseInt(e.target.value, 10),
                  })
                }
                min="1"
                max={2_147_483_647}
                className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-xs transition ${
                  getError("intervalMs")
                    ? "border-red-500 bg-red-50 focus:outline-none focus:ring-1 focus:ring-red-500 dark:border-red-500 dark:bg-red-950"
                    : "border-gray-300 bg-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                }`}
              />
              {getError("intervalMs") && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {getError("intervalMs")}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                Interval Jitter (ms, optional)
              </label>
              <input
                type="number"
                value={rule.intervalJitterMs ?? ""}
                onChange={(e) =>
                  onUpdate({
                    intervalJitterMs:
                      e.target.value === ""
                        ? undefined
                        : parseInt(e.target.value, 10),
                  })
                }
                min="0"
                max={2_147_483_647}
                className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-xs transition ${
                  getError("intervalJitterMs")
                    ? "border-red-500 bg-red-50 focus:outline-none focus:ring-1 focus:ring-red-500 dark:border-red-500 dark:bg-red-950"
                    : "border-gray-300 bg-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                }`}
              />
              {getError("intervalJitterMs") && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {getError("intervalJitterMs")}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                Reconnect Delay (ms)
              </label>
              <input
                type="number"
                value={rule.reconnectDelayMs ?? ""}
                onChange={(e) =>
                  onUpdate({
                    reconnectDelayMs:
                      e.target.value === ""
                        ? undefined
                        : parseInt(e.target.value, 10),
                  })
                }
                min="0"
                max={NETWORK_SIM_LIMITS.maxDelayMs}
                className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-xs transition ${
                  getError("reconnectDelayMs")
                    ? "border-red-500 bg-red-50 focus:outline-none focus:ring-1 focus:ring-red-500 dark:border-red-500 dark:bg-red-950"
                    : "border-gray-300 bg-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                }`}
              />
              {getError("reconnectDelayMs") && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {getError("reconnectDelayMs")}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
