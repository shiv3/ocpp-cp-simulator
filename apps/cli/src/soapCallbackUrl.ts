// SOAP callback-URL resolution (issue #183) lives beside the SOAP transport in
// the core (packages/core/src/cp/infrastructure/transport/soap/soapCallbackUrl.ts) so the
// web console can build the same URL without importing the CLI. This module
// keeps the old import path working for the CLI.
export * from "@ocpp-cp-simulator/core/cp/infrastructure/transport/soap/soapCallbackUrl";
