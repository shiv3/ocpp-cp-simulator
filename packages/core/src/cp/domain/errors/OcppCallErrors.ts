import type { OcppCallRejection } from "../types/OcppCall";

/** The CALL was refused before anything was written. */
export class OcppCallRejectedError extends Error {
  constructor(
    readonly reason: OcppCallRejection,
    message: string,
  ) {
    super(message);
    this.name = "OcppCallRejectedError";
  }
}

/** The CALL got no answer: nothing came back in time, or it never reached
 *  the wire / the connection closed before the answer. */
export class OcppCallNoAnswerError extends Error {
  constructor(
    readonly reason: "timeout" | "dropped",
    message: string,
  ) {
    super(message);
    this.name = "OcppCallNoAnswerError";
  }
}
