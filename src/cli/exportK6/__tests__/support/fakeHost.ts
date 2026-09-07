// src/cli/exportK6/__tests__/support/fakeHost.ts
// Shared in-memory ScenarioHost for the exported-runtime tests. Lives beside
// the tests (not under runtime/) so it never lands in an export bundle; shared
// so the cross-runtime agreement test drives the same interpreter path the
// interpreter tests do rather than a second stand-in (#329).
import type { ScenarioHost } from "../../runtime/interpreter";
import type { WireCall } from "../../runtime/types";

export class FakeHost implements ScenarioHost {
  connectorId = 1;
  sent: WireCall[] = [];
  status = "Available";
  overrides: Array<[string, string]> = [];
  configs: Array<[string, string]> = [];
  unlock: string | null = null;
  /** Scripted responses by action; default {} */
  responses = new Map<string, Record<string, unknown>>();
  /** Pending incoming-call waiters, resolved via emitCsmsCall(). */
  private waiters: Array<{
    actions: readonly string[];
    resolve: (v: { action: string; payload: Record<string, unknown> }) => void;
  }> = [];
  slept: number[] = [];

  async call(c: WireCall): Promise<Record<string, unknown>> {
    this.sent.push(c);
    return this.responses.get(c.action) ?? {};
  }
  waitForCsmsCall(actions: readonly string[], _timeoutMs: number | null) {
    return new Promise<{ action: string; payload: Record<string, unknown> }>(
      (resolve) => this.waiters.push({ actions, resolve }),
    );
  }
  emitCsmsCall(action: string, payload: Record<string, unknown>): void {
    const i = this.waiters.findIndex((w) => w.actions.includes(action));
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve({ action, payload });
  }
  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    // Yield a real macrotask instead of resolving on the microtask queue.
    // This lets the main walk and a background auto-meter loop take turns
    // (each sleep is a discrete "tick") instead of one starving the other
    // via an unbroken chain of microtasks — needed for the finally-stop test
    // below, where the loop would otherwise spin forever ahead of the walk
    // ever reaching runScenario's `finally`.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  nowIso(): string {
    return "2026-07-29T00:00:00.000Z";
  }
  getLocalStatus(): string {
    return this.status;
  }
  setLocalStatus(status: string): void {
    this.status = status;
  }
  async waitForLocalStatus(): Promise<void> {}
  armResponseOverride(action: string, status: string): void {
    this.overrides.push([action, status]);
  }
  setUnlockOutcome(outcome: string): void {
    this.unlock = outcome;
  }
  setLocalConfig(key: string, value: string): void {
    this.configs.push([key, value]);
  }
}
