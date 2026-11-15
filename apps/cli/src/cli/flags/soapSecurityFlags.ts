import { isHttpUrl } from "../../soapCallbackUrl";
import { isOff } from "../../vehicleCatalogConfig";
import { parseSecurityProfile, requireFlagValue } from "../flagValues";
import type { ParseState } from "./parseState";

/**
 * Extra WebSocket headers and subprotocols, SOAP callback / tunnel, the Open EV
 * Directory, security profile and TLS, and per-charge-point OCPP options.
 * Returns false when `arg` is none of them (#877).
 */
export function parseSoapSecurityFlag(
  s: ParseState,
  arg: string,
  next: string,
  cur: { i: number },
): boolean {
  switch (arg) {
    case "--header": {
      if (!next || next.startsWith("--")) {
        process.stderr.write(
          "Error: --header requires KEY:VALUE (use multiple --header flags for several headers)\n",
        );
        process.exit(1);
      }
      const idx = next.indexOf(":");
      if (idx <= 0) {
        process.stderr.write(
          `Error: --header value must be KEY:VALUE, got '${next}'\n`,
        );
        process.exit(1);
      }
      const k = next.slice(0, idx).trim();
      const v = next.slice(idx + 1).trim();
      if (!k) {
        process.stderr.write("Error: --header KEY part is empty\n");
        process.exit(1);
      }
      s.extraWsHeaders[k] = v;
      cur.i++;
      break;
    }
    case "--ws-subprotocol":
      if (!next || next.startsWith("--")) {
        process.stderr.write("Error: --ws-subprotocol requires a value\n");
        process.exit(1);
      }
      s.extraWsSubprotocols.push(next);
      cur.i++;
      break;
    case "--soap-callback-url":
      if (!next || next.startsWith("--")) {
        process.stderr.write("Error: --soap-callback-url requires a URL\n");
        process.exit(1);
      }
      s.soapCallbackUrl = next;
      cur.i++;
      break;
    case "--oed-base-url":
      if (!next || next.startsWith("--")) {
        process.stderr.write("Error: --oed-base-url requires a URL\n");
        process.exit(1);
      }
      if (!isHttpUrl(next) && !isOff(next)) {
        process.stderr.write(
          "Error: --oed-base-url must be an absolute http(s) URL or none\n",
        );
        process.exit(1);
      }
      s.oedBaseUrl = next;
      cur.i++;
      break;
    case "--oed-api-key-file":
      if (!next || next.startsWith("--")) {
        process.stderr.write("Error: --oed-api-key-file requires a path\n");
        process.exit(1);
      }
      s.oedApiKeyFile = next;
      cur.i++;
      break;
    case "--soap-public-base-url":
      if (!next || next.startsWith("--")) {
        process.stderr.write("Error: --soap-public-base-url requires a URL\n");
        process.exit(1);
      }
      if (!isHttpUrl(next)) {
        process.stderr.write(
          "Error: --soap-public-base-url must be an absolute http(s) URL\n",
        );
        process.exit(1);
      }
      s.soapPublicBaseUrl = next;
      cur.i++;
      break;
    case "--soap-tunnel":
      if (next !== "none" && next !== "ngrok") {
        process.stderr.write(
          "Error: --soap-tunnel must be one of: none, ngrok\n",
        );
        process.exit(1);
      }
      s.soapTunnel = next;
      cur.i++;
      break;
    case "--soap-tunnel-port": {
      // Whole value, not a prefix: "9702abc" and "1e3" are mistakes.
      const port = /^\d+$/.test(next ?? "") ? Number(next) : NaN;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write(
          "Error: --soap-tunnel-port must be a port number (0 picks a free one)\n",
        );
        process.exit(1);
      }
      s.soapTunnelPort = port;
      cur.i++;
      break;
    }
    case "--ngrok-auth-token":
    case "--ngrok-domain":
    case "--ngrok-api-url": {
      if (!next || next.startsWith("--")) {
        process.stderr.write(`Error: ${arg} requires a value\n`);
        process.exit(1);
      }
      if (arg === "--ngrok-api-url" && !isHttpUrl(next)) {
        process.stderr.write(
          "Error: --ngrok-api-url must be an absolute http(s) URL\n",
        );
        process.exit(1);
      }
      s.ngrok[arg] = next;
      cur.i++;
      break;
    }
    case "--soap-path":
      if (!next || next.startsWith("--") || !next.startsWith("/")) {
        process.stderr.write(
          "Error: --soap-path requires an absolute path starting with '/'\n",
        );
        process.exit(1);
      }
      s.soapPath = next.replace(/\/+$/, "") || "/";
      cur.i++;
      break;
    case "--security-profile":
      s.securityProfile = parseSecurityProfile(next);
      cur.i++;
      break;
    case "--authorization-key":
      s.authorizationKey = requireFlagValue("--authorization-key", next);
      if (!/^[0-9a-fA-F]+$/.test(s.authorizationKey)) {
        process.stderr.write(
          "Error: --authorization-key must be a non-empty hex string\n",
        );
        process.exit(1);
      }
      cur.i++;
      break;
    case "--tls-ca":
      s.tlsCaPath = requireFlagValue("--tls-ca", next);
      cur.i++;
      break;
    case "--tls-cert":
      s.tlsCertPath = requireFlagValue("--tls-cert", next);
      cur.i++;
      break;
    case "--tls-key":
      s.tlsKeyPath = requireFlagValue("--tls-key", next);
      cur.i++;
      break;
    case "--insecure-tls-key-perms":
      s.insecureTlsKeyPerms = true;
      break;
    case "--cpo-name":
      s.cpoName = requireFlagValue("--cpo-name", next);
      cur.i++;
      break;
    case "--inbound-validation": {
      const value = requireFlagValue("--inbound-validation", next);
      if (value !== "off" && value !== "warn" && value !== "enforce") {
        process.stderr.write(
          "Error: --inbound-validation must be off, warn or enforce\n",
        );
        process.exit(1);
      }
      s.inboundValidation = value;
      cur.i++;
      break;
    }
    case "--reservation-authorize-id-tag":
      s.reservationAuthorizeIdTag = true;
      break;
    default:
      return false;
  }
  return true;
}
