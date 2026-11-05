/**
 * Get15118EVCertificate fixtures (#537). The simulator has no EXI codec and
 * relays `exiRequest` / `exiResponse` as opaque base64, so these are opaque
 * byte strings in the shape the messages carry (base64, under the 2.0.1
 * bounds of 5600 / 7500 characters), not decodable ISO 15118 messages.
 */
function base64Of(seed: number, length: number): string {
  const bytes = Uint8Array.from(
    { length },
    (_, i) => (seed * 31 + i * 7) % 256,
  );
  return Buffer.from(bytes).toString("base64");
}

/** Stands for an EV's CertificateInstallationReq. */
export const EXI_REQUEST_FIXTURE = base64Of(1, 600);

/** Stand for the CertificateInstallationRes a CSMS returns, one per contract. */
export const EXI_RESPONSE_FIXTURES: readonly string[] = [
  base64Of(2, 1200),
  base64Of(3, 1200),
  base64Of(4, 1200),
];
