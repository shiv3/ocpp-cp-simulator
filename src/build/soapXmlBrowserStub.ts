// Browser-build stub for the daemon-only OCPP 1.5 SOAP XML libraries
// (`xmlbuilder2` + `fast-xml-parser`). `vite.config.ts` aliases both packages
// to this module for the browser build and dev server — never for vitest,
// which runs the real SOAP code in Node.
//
// Why this exists: `ChargePoint` statically imports the SOAP transport, so
// `soapEnvelope.ts` — and with it xmlbuilder2's CommonJS DOM stack
// (`@oozcitak/dom`, whose classes do `extends require("events").EventEmitter`
// and rely on CJS<->ESM interop wrappers) — is pulled into the browser
// bundle's static module graph. That happens even though OCPP 1.5 SOAP is
// daemon-only: it needs `--soap-callback-url` and an inbound SOAP server the
// web console can't run, so the browser never instantiates `OCPPSoapHandler`.
// Under some production module-init orderings (observed in the Alpine Docker
// build) that CJS interop calls `Object.defineProperty` on a not-yet-
// initialized export and throws "Object.defineProperty called on non-object",
// blanking the whole SPA (issue #127). Stubbing the libraries out of the
// browser build removes that entire code path — and supersedes the older
// `events` polyfill workaround, which only papered over the same root cause.
//
// These symbols are never reached in the browser; if they ever are, fail loud.
const daemonOnly = (): never => {
  throw new Error(
    "OCPP 1.5 SOAP XML tooling is daemon-only and unavailable in the browser web console",
  );
};

// Stands in for `import { create } from "xmlbuilder2"`.
export const create = (): never => daemonOnly();

// Stands in for `import { XMLParser } from "fast-xml-parser"`.
export class XMLParser {
  parse(): never {
    return daemonOnly();
  }
}
