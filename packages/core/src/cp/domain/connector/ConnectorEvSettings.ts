import type { EventEmitter } from "../../shared/EventEmitter";
import {
  type EVSettings,
  type EVSettingsPatch,
  assertRequiredFieldsKept,
  defaultEVSettings,
  withoutNulls,
} from "./EVSettings";
import { withNormalizedChargingCurve } from "./ChargingCurve";
import type { ConnectorEvents } from "./ConnectorEvents";

/** What the EV settings handling needs from the connector that owns it. */
export interface ConnectorEvSettingsHost {
  evSettings(): EVSettings;
  setEvSettings(settings: EVSettings): void;
  emit: EventEmitter<ConnectorEvents>["emit"];
}

/**
 * The write paths of a connector's EV settings (#105, #333, #458): the
 * normalizing setter, the explicit/scenario override and the default
 * propagation. Moved verbatim out of `Connector` (#877); the settings value
 * stays on the connector and is reached through the host.
 */
export class ConnectorEvSettings {
  // True while an explicit/scenario override is active (#105): a running
  // scenario's evSettings must win over any later Default EV Settings
  // propagation (e.g. a browser reload in remote mode re-pushing the
  // default onto every connector while a scenario is mid-flight on the
  // daemon). Cleared when the scenario that set it stops/completes.
  private overridden = false;

  constructor(private readonly host: ConnectorEvSettingsHost) {}

  /** The setter body: see {@link Connector.evSettings}. */
  set(settings: EVSettings): void {
    // Normalized here, at the one boundary every write to evSettings passes
    // through (the setter, `applyEvSettingsOverride` and
    // `applyDefaultEvSettings` all funnel here) — so every reader
    // (`powerFractionAtSoc`, the meter scheduler) can assume an
    // already-sorted, already-validated curve rather than re-normalizing
    // per sample (#301).
    // A `null` is a merge patch's "remove" (#458): never stored, and refused
    // for a required field before anything is written.
    assertRequiredFieldsKept(settings);
    const next = withNormalizedChargingCurve(withoutNulls({ ...settings }));
    this.host.setEvSettings(next);
    this.host.emit("evSettingsChange", { settings: next });
  }

  /**
   * Explicit/scenario set (#105): merges `partial` into the current EV
   * settings and marks the connector as overridden, so a later Default EV
   * Settings propagation (`applyDefaultEvSettings`) no-ops until
   * {@link clearEvSettingsOverride} runs.
   */
  applyEvSettingsOverride(partial: EVSettingsPatch): void {
    // Refused before the override is claimed: a rejected write changes
    // nothing, the ownership included.
    assertRequiredFieldsKept(partial);
    this.overridden = true;
    // A merge patch: absent keys keep their value, `null` removes the key
    // (the setter drops it).
    this.set({ ...this.host.evSettings(), ...partial } as EVSettings);
  }

  /**
   * Default-EV-settings propagation (#105), only when no override is active —
   * a running scenario/explicit override wins over this until cleared.
   *
   * Merged onto the built-in {@link defaultEVSettings} (#333), as
   * {@link applyEvSettingsOverride} merges onto the current settings: a field
   * the default omits reads back as the built-in value rather than vanishing,
   * so a partial `ev_settings.apply_default` can no longer leave a required
   * field such as `initialSoc` absent. Onto the constant, not the current
   * settings: a default that names no `chargingCurve` describes a car without
   * one, so nothing of an earlier default or override carries over.
   */
  applyDefaultEvSettings(settings: EVSettingsPatch): void {
    if (this.overridden) return;
    this.set({ ...defaultEVSettings, ...settings } as EVSettings);
  }

  /**
   * Unmark the override (current values are kept as-is) so the next
   * `applyDefaultEvSettings` call can take effect. Called when the scenario
   * that set the override stops or completes.
   */
  clearEvSettingsOverride(): void {
    this.overridden = false;
  }
}
