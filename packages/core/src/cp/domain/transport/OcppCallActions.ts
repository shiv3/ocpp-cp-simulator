/** #389: the station-initiated actions an expert OCPP call may send on one
 *  OCPP-J version (#575 port). The codec's `OcppCallCatalog` implements it. */
export interface OcppCallActions {
  readonly actions: readonly string[];
  /** OCPP 2.1 SEND actions (message type 6): station-initiated, unconfirmed.
   *  Empty before 2.1. */
  readonly sendActions: readonly string[];
  isSupported(action: string): boolean;
  isSendSupported(action: string): boolean;
  /** The outgoing schema check: null when the payload is schema-valid. */
  validate(action: string, payload: unknown): string | null;
  /** The smallest schema-valid payload of the action, to start from. */
  defaultPayload(action: string): Record<string, unknown>;
}
