import type {
  CertificateQuirks,
  InboundCallPolicy,
  ResponseOverrideRepeat,
  ResponseOverrideSpec,
} from "./ChargePointTypes";

/**
 * Small registries that change how the charge point answers CSMS calls:
 * one-shot response overrides (issue #110), sticky inbound call policies
 * and certificate quirks (issue #247). The charge point keeps the public
 * methods as thin delegates.
 */
export class CallOverrides {
  /** Armed response overrides per incoming action: the one-shot canned
   *  `{ status }` of a scenario responseOverride node (issue #110), and the
   *  richer answers a test arms through the control plane. One per action;
   *  arming again replaces it. */
  private readonly _responseOverrides = new Map<
    string,
    { spec: ResponseOverrideSpec; remaining: number }
  >();
  /** Sticky per-action inbound call policies (issue #247). When a CSMS-initiated
   *  CALL arrives for an action with a policy, reply with CALLERROR or stay silent
   *  instead of processing normally. Survive reconnects until explicitly cleared. */
  private readonly _inboundCallPolicies = new Map<string, InboundCallPolicy>();
  /** Certificate quirks for CSR generation and acceptance (issue #247).
   *  Used to emulate OCPP conformance tool behavior. Sticky until cleared. */
  private _certificateQuirks: CertificateQuirks = {};

  armResponseOverride(action: string, status: string): void {
    this.armResponse(action, { mode: "status", status });
  }

  /**
   * Arm `spec` for the next `times` CALLs of `action` (default 1), or until
   * cleared with `persistent`.
   */
  armResponse(
    action: string,
    spec: ResponseOverrideSpec,
    repeat: ResponseOverrideRepeat = {},
  ): void {
    const remaining = repeat.persistent
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor(repeat.times ?? 1));
    this._responseOverrides.set(action, { spec, remaining });
  }

  /** The armed override for `action`, one use spent; null when none. */
  consumeResponse(action: string): ResponseOverrideSpec | null {
    const armed = this._responseOverrides.get(action);
    if (armed === undefined) return null;
    armed.remaining -= 1;
    if (armed.remaining <= 0) this._responseOverrides.delete(action);
    return armed.spec;
  }

  /** Returns and clears the armed status of a `status` override; null for
   *  none. Another mode is not consumed: its answer is not a status. */
  consumeResponseOverride(action: string): string | null {
    const armed = this._responseOverrides.get(action);
    if (armed?.spec.mode !== "status") return null;
    this.consumeResponse(action);
    return armed.spec.status;
  }

  hasResponseOverride(action: string): boolean {
    return this._responseOverrides.has(action);
  }

  clearResponseOverride(action: string): void {
    this._responseOverrides.delete(action);
  }

  /** Drop every armed response override (connection closed, issue #110). */
  clearResponseOverrides(): number {
    const cleared = this._responseOverrides.size;
    this._responseOverrides.clear();
    return cleared;
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
