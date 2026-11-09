import type { RawFrameOutcome, RawFrameRequest } from "../types/OcppCall";

/** #393: where an expert raw frame goes (#575 port). The OCPP-J transport's
 *  `RawFrameSender` implements it; a SOAP charge point has none. */
export interface RawFrameSink {
  send(request: RawFrameRequest): Promise<RawFrameOutcome>;
}
