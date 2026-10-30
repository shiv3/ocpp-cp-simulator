/**
 * The `Target` attribute of the 2.x device-model variables that have one
 * (#538), keyed by the configuration key of the variable's Actual value.
 * A TargetDelta / TargetDeltaRelative monitor (2.1 N07.FR.22, FR.23)
 * compares the Actual value with this one.
 *
 * Only declared keys have a Target; a declared key starts without a value
 * (GetVariables then answers an empty string, B06.FR.13). Targets live in
 * memory: they are not persisted.
 */
export class DeviceModelTargets {
  private readonly declared = new Set<string>();
  private readonly values = new Map<string, number>();
  private readonly listeners = new Set<(valueKey: string) => void>();

  declare(valueKey: string): void {
    this.declared.add(valueKey);
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

  onChange(listener: (valueKey: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
