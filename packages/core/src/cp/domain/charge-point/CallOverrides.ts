import type { CertificateQuirks, InboundCallPolicy } from "./ChargePointTypes";

/**
 * Small registries that change how the charge point answers CSMS calls:
 * one-shot response overrides (issue #110), sticky inbound call policies
 * and certificate quirks (issue #247). The charge point keeps the public
 * methods as thin delegates.
 */
export class CallOverrides {
  /** One-shot canned `{ status }` responses per incoming action,
   *  armed by a scenario responseOverride node (issue #110). */
  private readonly _responseOverrides = new Map<string, string>();
  /** Sticky per-action inbound call policies (issue #247). When a CSMS-initiated
   *  CALL arrives for an action with a policy, reply with CALLERROR or stay silent
   *  instead of processing normally. Survive reconnects until explicitly cleared. */
  private readonly _inboundCallPolicies = new Map<string, InboundCallPolicy>();
  /** Certificate quirks for CSR generation and acceptance (issue #247).
   *  Used to emulate OCPP conformance tool behavior. Sticky until cleared. */
  private _certificateQuirks: CertificateQuirks = {};

  armResponseOverride(action: string, status: string): void {
    this._responseOverrides.set(action, status);
  }

  consumeResponseOverride(action: string): string | null {
    const status = this._responseOverrides.get(action);
    if (status === undefined) return null;
    this._responseOverrides.delete(action);
    return status;
  }

  hasResponseOverride(action: string): boolean {
    return this._responseOverrides.has(action);
  }

  clearResponseOverride(action: string): void {
    this._responseOverrides.delete(action);
  }

  /** Drop every armed response override (connection closed, issue #110). */
  clearResponseOverrides(): void {
    this._responseOverrides.clear();
  }

  setInboundCallPolicy(action: string, policy: InboundCallPolicy): void {
    this._inboundCallPolicies.set(action, policy);
  }

  getInboundCallPolicy(action: string): InboundCallPolicy | undefined {
    return this._inboundCallPolicies.get(action);
  }

  clearInboundCallPolicy(action?: string): void {
    if (action === undefined) {
      this._inboundCallPolicies.clear();
    } else {
      this._inboundCallPolicies.delete(action);
    }
  }

  setCertificateQuirks(quirks: Partial<CertificateQuirks>): void {
    this._certificateQuirks = { ...this._certificateQuirks, ...quirks };
  }

  clearCertificateQuirks(): void {
    this._certificateQuirks = {};
  }

  get certificateQuirks(): CertificateQuirks {
    return this._certificateQuirks;
  }
}
