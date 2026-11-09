// The SOAP path helpers live beside the SOAP transport in the core
// (packages/core/src/cp/infrastructure/transport/soap/soapPath.ts), because
// soapCallbackUrl.ts, which the web console also uses, depends on them. This
// module keeps the old import path working for the CLI.
export * from "@ocpp-cp-simulator/core/cp/infrastructure/transport/soap/soapPath";
