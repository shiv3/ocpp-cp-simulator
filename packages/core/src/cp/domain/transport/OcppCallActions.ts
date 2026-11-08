/** #389: the station-initiated actions an expert OCPP call may send on one
 *  OCPP-J version (#575 port). The codec's `OcppCallCatalog` implements it. */
export interface OcppCallActions {
  readonly actions: readonly string[];
  isSupported(action: string): boolean;
}
