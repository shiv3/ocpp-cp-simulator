import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { OCPP_2_1 } from "../../../domain/types/OcppVersion";

/** `IdTokenEnumType` of OCPP 2.0.1 Part 2 §3.43. On 2.1 `IdTokenType.type` is
 *  a free string of at most 20 characters whose standard values
 *  (`IdTokenEnumStringType`, 2.1 Appendices ch. 7.1) add `DirectPayment`,
 *  `EVCCID` and `VIN`: the type is extensible there, so 2.1 is not checked
 *  against a list. */
const ID_TOKEN_TYPES: ReadonlySet<string> = new Set([
  "Central",
  "eMAID",
  "ISO14443",
  "ISO15693",
  "KeyCode",
  "Local",
  "MacAddress",
  "NoAuthorization",
]);

/** `IdToken.idToken` is `identifierString` with maxLength 36 on 2.0.1 and 255
 *  on 2.1 (the JSON schemas of the two editions); `type` is at most 20
 *  characters on 2.1. */
const ID_TOKEN_MAX_LENGTH = { v201: 36, v21: 255 } as const;
const ID_TOKEN_TYPE_MAX_LENGTH_V21 = 20;

/** A rejection of RequestStartTransaction with the `statusInfo.reasonCode`
 *  that explains it (Part 2 Appendices ch. 5 "Reason Codes"; `reasonCode` is a
 *  free string of at most 20 characters). */
export interface RemoteStartRejection {
  status: "Rejected";
  statusInfo: { reasonCode: string; additionalInfo: string };
}

export type RemoteStartDecision =
  | { ok: true; connectorId: number }
  | { ok: false; rejection: RemoteStartRejection };

interface IdTokenLike {
  idToken?: unknown;
  type?: unknown;
}

interface RequestStartLike {
  evseId?: number;
  idToken?: IdTokenLike;
  groupIdToken?: IdTokenLike;
  chargingProfile?: {
    chargingProfilePurpose?: string;
    transactionId?: unknown;
  };
}

function reject(
  reasonCode: string,
  additionalInfo: string,
): RemoteStartDecision {
  return {
    ok: false,
    rejection: {
      status: "Rejected",
      statusInfo: { reasonCode, additionalInfo },
    },
  };
}

function checkIdToken(
  token: IdTokenLike | undefined,
  name: string,
  v21: boolean,
): RemoteStartDecision | null {
  if (!token || typeof token.idToken !== "string") {
    return reject("InvalidIdToken", `${name}.idToken is missing`);
  }
  if (typeof token.type !== "string" || token.type === "") {
    return reject("InvalidIdToken", `${name}.type is missing`);
  }
  // NoAuthorization: "IdToken field SHALL be left empty" (IdTokenEnumType /
  // IdTokenEnumStringType); every other type needs a value.
  if (token.idToken === "" && token.type !== "NoAuthorization") {
    return reject("InvalidIdToken", `${name}.idToken is empty`);
  }
  const max = v21 ? ID_TOKEN_MAX_LENGTH.v21 : ID_TOKEN_MAX_LENGTH.v201;
  if (token.idToken.length > max) {
    return reject(
      "InvalidIdToken",
      `${name}.idToken is longer than ${max} characters`,
    );
  }
  if (v21) {
    if (token.type.length > ID_TOKEN_TYPE_MAX_LENGTH_V21) {
      return reject(
        "InvalidIdToken",
        `${name}.type is longer than ${ID_TOKEN_TYPE_MAX_LENGTH_V21} characters`,
      );
    }
  } else if (!ID_TOKEN_TYPES.has(token.type)) {
    return reject("InvalidIdToken", `${name}.type is not an IdTokenEnumType`);
  }
  return null;
}

/**
 * Validates a 2.x RequestStartTransaction.req and picks the connector (EVSE)
 * the transaction starts on.
 *
 * - F01.FR.09 / F01.FR.11 / F01.FR.26: a `chargingProfile` SHALL be a
 *   `TxProfile` and SHALL NOT carry a `transactionId`; the rejection carries
 *   `InvalidProfile`.
 * - C16.FR.03 / C12.FR.09: an IdToken whose group id is
 *   `AuthCtrlr.MasterPassGroupId` SHALL NOT start a transaction. Only the
 *   request's `groupIdToken` is compared (station configuration key
 *   `MasterPassGroupId`; unset means no master pass). A plain `idToken`
 *   equal to the group id is not a master pass.
 * - F01.FR.21 / F01.FR.22: an EVSE reserved for another idToken and another
 *   group is rejected; one reserved for this idToken or group is accepted.
 * - F01.FR.23: an EVSE that is Unavailable or Faulted is rejected.
 * - `evseId` is optional (F01.FR.06; F01.FR.07 lets the station reject
 *   without it); without it the station picks an EVSE reserved for this
 *   idToken or group first, then an Available / Preparing one.
 *
 * Reason codes are Appendix ch. 5 codes only. Where the Appendix has none
 * (an inoperative EVSE, no free EVSE) the code is `Unspecified` and
 * `additionalInfo` says what happened.
 */
export function decideRemoteStart(
  cp: ChargePoint,
  request: RequestStartLike,
): RemoteStartDecision {
  const v21 = cp.ocppVersion === OCPP_2_1;
  const bad =
    checkIdToken(request.idToken, "idToken", v21) ??
    (request.groupIdToken
      ? checkIdToken(request.groupIdToken, "groupIdToken", v21)
      : null);
  if (bad) return bad;

  const masterPass = cp.configuration.getString("MasterPassGroupId");
  if (masterPass && request.groupIdToken?.idToken === masterPass) {
    // C16.FR.03; "Provided idToken is not valid" is the Appendix code for a
    // token RequestStartTransaction cannot use.
    return reject(
      "InvalidIdToken",
      "A master pass token (group id MasterPassGroupId) cannot start a transaction",
    );
  }

  const profile = request.chargingProfile;
  if (profile) {
    if (profile.chargingProfilePurpose !== "TxProfile") {
      return reject(
        "InvalidProfile",
        "chargingProfile.chargingProfilePurpose must be TxProfile",
      );
    }
    if (profile.transactionId !== undefined) {
      return reject(
        "InvalidProfile",
        "chargingProfile.transactionId must not be set in a RequestStartTransaction",
      );
    }
  }

  const busy = (id: number): boolean => {
    const tx = cp.getConnector(id)?.transaction;
    return !!tx && tx.stopTime === null;
  };
  // A reservation belongs to this request when it was made for this idToken
  // or for this groupIdToken (F01.FR.21 / F01.FR.22).
  const reservedForOther = (id: number): boolean => {
    const reservation = cp.reservationManager.peekReservationForConnector(id);
    if (!reservation) return false;
    const group = request.groupIdToken?.idToken;
    return (
      reservation.idTag !== request.idToken?.idToken &&
      !(group !== undefined && reservation.parentIdTag === group)
    );
  };
  const reservedForRequest = (id: number): boolean =>
    cp.reservationManager.peekReservationForConnector(id) !== undefined &&
    !reservedForOther(id);

  if (request.evseId !== undefined) {
    const connector =
      request.evseId >= 1 ? cp.getConnector(request.evseId) : undefined;
    if (!connector) {
      return reject("UnknownEvse", `EVSE ${request.evseId} does not exist`);
    }
    if (connector.availability !== "Operative") {
      // F01.FR.23: Rejected; the Appendix has no reason code for it.
      return reject("Unspecified", `EVSE ${request.evseId} is inoperative`);
    }
    if (busy(connector.id)) {
      return reject(
        "TxInProgress",
        `EVSE ${request.evseId} already has a transaction`,
      );
    }
    if (reservedForOther(connector.id)) {
      return reject(
        "Unspecified",
        `EVSE ${request.evseId} is reserved for another idToken`,
      );
    }
    return { ok: true, connectorId: connector.id };
  }

  const candidates = Array.from(cp.connectors.values())
    .filter((c) => c.id >= 1 && c.availability === "Operative" && !busy(c.id))
    .sort((a, b) => a.id - b.id);
  const free =
    candidates.find(
      (c) => c.status === "Reserved" && reservedForRequest(c.id),
    ) ?? candidates.find((c) => ["Available", "Preparing"].includes(c.status));
  if (!free) {
    return reject("Unspecified", "No EVSE is free to start a transaction");
  }
  return { ok: true, connectorId: free.id };
}
