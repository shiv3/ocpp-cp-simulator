/**
 * The rules that may take an inbound CSMS CALL over from the default path
 * (docs/analyses/charger-engine.md, "BehaviorRegistry"). One per charge point.
 *
 * Stage A ships the seam only: {@link BehaviorRegistry.resolve} always answers
 * "default", so no call is ever diverted and the wire is unchanged. Code
 * behaviors and scenario rules register here in later stages.
 */

/** An inbound CSMS CALL as the registry sees it. */
export interface BehaviorCall {
  /** The action as it arrived on the wire. */
  readonly action: string;
  readonly payload: unknown;
  /** The connector the CALL names, when it names one. */
  readonly connectorId?: number;
}

/** What to do with a CALL. */
export type BehaviorResolution =
  /** No rule applies: run the default path. */
  { readonly kind: "default" };

const DEFAULT_RESOLUTION: BehaviorResolution = { kind: "default" };

export class BehaviorRegistry {
  /**
   * Synchronous, and called before the payload is validated, so a rule can
   * own a malformed CALL. Always `default` in this version.
   */
  resolve(_call: BehaviorCall): BehaviorResolution {
    return DEFAULT_RESOLUTION;
  }
}
