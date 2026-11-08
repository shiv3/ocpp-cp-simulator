import type {
  CustomerInformationRequestV201,
  CustomerInformationResponseV201,
  NotifyCustomerInformationRequestV201,
} from "@ocpp-cp-sim/ocpp/index";
import type {
  V201HandlerResult,
  V201InboundContext,
} from "./inboundRegistryV201";
import { idTokenKey } from "../../../domain/auth/idTokenKey";
import { stationNow } from "../stationNow";

/** `NotifyCustomerInformationRequest.data` is at most 512 characters
 *  (Part 2 N09, schema `maxLength`). */
export const CUSTOMER_INFORMATION_MAX_DATA = 512;

/** Cuts `text` into the `data` parts of NotifyCustomerInformation, never
 *  inside a surrogate pair. An empty text is one empty part. */
export function splitCustomerInformation(
  text: string,
  max = CUSTOMER_INFORMATION_MAX_DATA,
): string[] {
  if (text === "") return [""];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * N09 / N10 CustomerInformation.req (#602, 2.0.1 / 2.1 Part 2).
 *
 * The customer is named by `idToken` and / or `customerIdentifier`; both are
 * matched, case insensitively, against the identifiers the station holds.
 * A `customerCertificate` alone names nothing the simulator stores (it
 * keeps no per-certificate customer data).
 *
 * - No `idToken`, `customerIdentifier` or `customerCertificate`: `Invalid`.
 * - `report` and `clear` both false: `Rejected` (nothing to do).
 * - Otherwise `Accepted`. Once the answer settled: with `report`, the data
 *   held (Authorization Cache entry, Local Authorization List entry, running
 *   transactions) goes out in NotifyCustomerInformation parts (`seqNo` from
 *   0, `tbc` on all but the last), taken before a `clear`; with `clear`, the
 *   matching Authorization Cache entries are removed (whatever the cache
 *   switch says). The Local Authorization List belongs to the CSMS
 *   (SendLocalList) and is never cleared here.
 */
export function handleCustomerInformationV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const req = payload as CustomerInformationRequestV201;
  const cp = ctx.chargePoint;

  const identifiers = [req.idToken?.idToken, req.customerIdentifier].filter(
    (value): value is string => value !== undefined && value !== "",
  );
  if (identifiers.length === 0 && !req.customerCertificate) {
    return {
      response: {
        status: "Invalid",
        statusInfo: {
          reasonCode: "MissingParam",
          additionalInfo:
            "One of idToken, customerIdentifier or customerCertificate is required",
        },
      } satisfies CustomerInformationResponseV201,
    };
  }
  if (!req.report && !req.clear) {
    return {
      response: {
        status: "Rejected",
        statusInfo: {
          reasonCode: "NoAction",
          additionalInfo: "Neither report nor clear is set",
        },
      } satisfies CustomerInformationResponseV201,
    };
  }

  return {
    response: { status: "Accepted" } satisfies CustomerInformationResponseV201,
    afterResult: () => {
      const lines: string[] = [];
      if (req.report) {
        lines.push(
          `Customer information of ${identifiers.join(", ") || "the given certificate"}`,
        );
        for (const id of identifiers) {
          const cached = cp.authorization.cache.get(id);
          lines.push(
            cached
              ? `Authorization cache ${cached.idToken}: status ${cached.status}` +
                  (cached.expiresAt !== undefined
                    ? `, expires ${new Date(cached.expiresAt).toISOString()}`
                    : "") +
                  (cached.parentId ? `, group ${cached.parentId}` : "")
              : `Authorization cache ${id}: no entry`,
          );
          const listed = cp.localAuthListManager.getEntry(id);
          lines.push(
            listed
              ? `Local authorization list ${id}: status ${listed.status}` +
                  (listed.expiryDate ? `, expires ${listed.expiryDate}` : "") +
                  (listed.parentIdTag ? `, group ${listed.parentIdTag}` : "")
              : `Local authorization list ${id}: no entry`,
          );
          const running = Array.from(cp.connectors.values()).filter(
            (c) =>
              c.hasRunningTransaction &&
              c.transaction !== null &&
              idTokenKey(c.transaction.tagId) === idTokenKey(id),
          );
          for (const c of running) {
            lines.push(`Running transaction of ${id} on EVSE ${c.id}`);
          }
        }
      }

      let cleared = 0;
      if (req.clear) {
        for (const id of identifiers) {
          if (cp.authorization.cache.remove(id)) cleared += 1;
        }
        if (req.report) {
          lines.push(`Cleared ${cleared} authorization cache entries`);
        }
      }

      if (!req.report) return;
      const parts = splitCustomerInformation(lines.join("\n"));
      const generatedAt = stationNow(cp).toISOString();
      parts.forEach((data, seqNo) => {
        ctx.sendCall("NotifyCustomerInformation", {
          data,
          seqNo,
          generatedAt,
          requestId: req.requestId,
          ...(seqNo < parts.length - 1 ? { tbc: true } : {}),
        } satisfies NotifyCustomerInformationRequestV201);
      });
    },
  };
}
