/** The attributes that bound a Target (B05 remark: MinSet, MaxSet). */
export type DeviceModelTargetLimit = "MinSet" | "MaxSet";

/**
 * The `Target` attribute of the 2.x device-model variables that have one
 * (#538), keyed by the configuration key of the variable's Actual value.
 * A TargetDelta / TargetDeltaRelative monitor (2.1 N07.FR.22, FR.23)
 * compares the Actual value with this one.
 *
 * A declared key also has the `MinSet` and `MaxSet` attributes: the lowest
 * and highest Target the CSMS allows (2.0.1 Part 2 §3.2 AttributeEnumType,
 * Part 1 §4 example "The target may not be set above/below this value"). A
 * Target outside them is refused by SetVariables. Like Targets they live in
 * memory and start unset.
 *
 * Only declared keys have a Target; a declared key starts without a value
 * (GetVariables then answers an empty string, B06.FR.13). Targets live in
 * memory: they are not persisted.
 */
export class DeviceModelTargets {
  private readonly declared = new Set<string>();
  private readonly values = new Map<string, number>();
  private readonly limits = {
    MinSet: new Map<string, number>(),
    MaxSet: new Map<string, number>(),
  };
  private readonly listeners = new Set<(valueKey: string) => void>();

  declare(valueKey: string): void {
    this.declared.add(valueKey);
  }

  /** Drop a key's Target and its value, as when its EVSE is removed. */
  undeclare(valueKey: string): void {
    this.declared.delete(valueKey);
    this.values.delete(valueKey);
    this.limits.MinSet.delete(valueKey);
    this.limits.MaxSet.delete(valueKey);
  }

  supports(valueKey: string): boolean {
    return this.declared.has(valueKey);
  }

  get(valueKey: string): number | undefined {
    return this.values.get(valueKey);
  }

  /** Set a declared key's target; listeners hear of a real change only. */
  set(valueKey: string, value: number): void {
    if (!this.declared.has(valueKey)) {
      throw new Error(`${valueKey} has no Target attribute`);
    }
    if (this.values.get(valueKey) === value) return;
    this.values.set(valueKey, value);
    for (const listener of this.listeners) listener(valueKey);
  }

  getLimit(
    valueKey: string,
    limit: DeviceModelTargetLimit,
  ): number | undefined {
    return this.limits[limit].get(valueKey);
  }

  /** Set a declared key's MinSet or MaxSet. */
  setLimit(
    valueKey: string,
    limit: DeviceModelTargetLimit,
    value: number,
  ): void {
    if (!this.declared.has(valueKey)) {
      throw new Error(`${valueKey} has no ${limit} attribute`);
    }
    this.limits[limit].set(valueKey, value);
  }

  onChange(listener: (valueKey: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
