import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";

/** `IdTokenEnumType` of OCPP 2.0.1 Part 2 §3.43 (2.1 keeps the same values). */
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

/** `IdToken.idToken` and `AdditionalInfo.additionalIdToken` are
 *  `identifierString` with maxLength 36 (Part 2 §2.28 / §3.43 / §2.1). */
const ID_TOKEN_MAX_LENGTH = 36;

/** A rejection of RequestStartTransaction with the `statusInfo.reasonCode`
 *  that explains it (Part 2 Appendix 5.2 reason codes; `reasonCode` is a
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
): RemoteStartDecision | null {
  if (!token || typeof token.idToken !== "string" || token.idToken === "") {
    return reject("InvalidIdToken", `${name}.idToken is empty`);
  }
  if (token.idToken.length > ID_TOKEN_MAX_LENGTH) {
    return reject(
      "InvalidIdToken",
      `${name}.idToken is longer than ${ID_TOKEN_MAX_LENGTH} characters`,
    );
  }
  if (typeof token.type !== "string" || !ID_TOKEN_TYPES.has(token.type)) {
    return reject("InvalidIdToken", `${name}.type is not an IdTokenEnumType`);
  }
  return null;
}

/**
 * Validates a 2.x RequestStartTransaction.req and picks the connector (EVSE)
 * the transaction starts on.
 *
 * - F01.FR.11 / F01.FR.12: a `chargingProfile` SHALL be a `TxProfile` and
 *   SHALL NOT carry a `transactionId` (the transaction does not exist yet).
 * - `AuthCtrlr.MasterPassGroupId`: tokens of that group can stop
 *   transactions but cannot start one, so an `idToken` or `groupIdToken`
 *   equal to it is rejected. The variable is read from the station
 *   configuration key `MasterPassGroupId`; unset means no master pass.
 * - `evseId` is optional (Part 2 §2.12.1); without it the first Operative
 *   connector without a running transaction that is not Reserved is used.
 */
export function decideRemoteStart(
  cp: ChargePoint,
  request: RequestStartLike,
): RemoteStartDecision {
  const bad =
    checkIdToken(request.idToken, "idToken") ??
    (request.groupIdToken
      ? checkIdToken(request.groupIdToken, "groupIdToken")
      : null);
  if (bad) return bad;

  const masterPass = cp.configuration.getString("MasterPassGroupId");
  if (masterPass) {
    if (
      request.idToken?.idToken === masterPass ||
      request.groupIdToken?.idToken === masterPass
    ) {
      return reject(
        "MasterPassNotAllowed",
        "A master pass token cannot start a transaction",
      );
    }
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

  if (request.evseId !== undefined) {
    const connector =
      request.evseId >= 1 ? cp.getConnector(request.evseId) : undefined;
    if (!connector) {
      return reject("UnknownEvse", `EVSE ${request.evseId} does not exist`);
    }
    if (connector.availability !== "Operative") {
      return reject("Unavailable", `EVSE ${request.evseId} is inoperative`);
    }
    if (busy(connector.id)) {
      return reject(
        "TxInProgress",
        `EVSE ${request.evseId} already has a transaction`,
      );
    }
    return { ok: true, connectorId: connector.id };
  }

  const free = Array.from(cp.connectors.values())
    .filter((c) => c.id >= 1)
    .sort((a, b) => a.id - b.id)
    .find(
      (c) =>
        c.availability === "Operative" &&
        !busy(c.id) &&
        ["Available", "Preparing"].includes(c.status),
    );
  if (!free)
    return reject("NoFreeEvse", "No EVSE is free to start a transaction");
  return { ok: true, connectorId: free.id };
}
