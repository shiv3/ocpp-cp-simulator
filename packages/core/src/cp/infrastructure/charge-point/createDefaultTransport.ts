import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type {
  ChargePointTransport,
  TransportContext,
} from "../../domain/charge-point/ChargePointDeps";
import { isSoapVersion } from "../../domain/types/OcppVersion";
import { OCPPWebSocket } from "../transport/OCPPWebSocket";
import { RawFrameSender } from "../transport/RawFrameSender";
import { SupervisionUrlPool } from "../transport/SupervisionUrlPool";
import { getOcppCallCatalog } from "../transport/codec/ocppCallCatalog";
import { getProtocolProfile } from "../transport/profile/profiles";
import { OCPPSoapHandler } from "../transport/soap";
import {
  SOAP_OPERATION_NAMES,
  soapDialectForVersion,
  type SoapOperation,
} from "../transport/soap/dialect";

/**
 * The production transport of a charge point (#575): a SOAP handler for the
 * SOAP versions, else an {@link OCPPWebSocket} with its raw-frame sender,
 * its supervision URL pool (more than one URL) and the version's message
 * handler. Called by the {@link ChargePoint} constructor through
 * `ChargePointDeps.createTransport`.
 */
export function createDefaultTransport(
  cp: ChargePoint,
  ctx: TransportContext,
): ChargePointTransport {
  const { ocppVersion, transportOptions } = ctx;
  if (isSoapVersion(ocppVersion)) {
    const dialect = soapDialectForVersion(ocppVersion);
    return {
      socket: null,
      rawFrames: null,
      handler: new OCPPSoapHandler(cp, ctx.logger, {
        centralSystemUrl: ctx.transportUrl,
        soapCallbackUrl: transportOptions.soapCallbackUrl,
        requestTimeoutMs: transportOptions.soapRequestTimeoutMs,
        dialect,
      }),
      callCatalog: getOcppCallCatalog(ocppVersion),
      receivesCsmsCall: (action) => {
        if (!(SOAP_OPERATION_NAMES as readonly string[]).includes(action)) {
          return false;
        }
        const metadata = dialect.operationMetadata[action as SoapOperation];
        return metadata?.target === "cp" || metadata?.bidirectional === true;
      },
    };
  }
  const socket = new OCPPWebSocket(
    ctx.wsUrl,
    cp.id,
    ctx.logger,
    ctx.basicAuth,
    ctx.extraWsHeaders,
    ctx.extraWsSubprotocols,
    ocppVersion,
    ctx.securityProfile,
    ctx.authorizationKey,
    ctx.cpoName,
    ctx.tls,
  );
  const rawFrames = new RawFrameSender(socket, () => cp.clock);
  const supervisionUrls = transportOptions.supervisionUrls;
  if (supervisionUrls && supervisionUrls.length > 1) {
    socket.setSupervisionUrlPool(
      new SupervisionUrlPool(
        supervisionUrls,
        transportOptions.urlDistribution,
        cp.id,
      ),
    );
  }
  return {
    socket,
    rawFrames,
    handler: getProtocolProfile(ocppVersion).createMessageHandler(
      cp,
      socket,
      ctx.logger,
    ),
    callCatalog: getOcppCallCatalog(ocppVersion),
    receivesCsmsCall: () => null,
  };
}
