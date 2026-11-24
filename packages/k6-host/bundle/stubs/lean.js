// Stands in for a package the OCPP 1.6J station over ws:// never reaches:
// X.509 / ASN.1 (`domain/security`, signed meter data), `tsyringe` and
// `reflect-metadata` (only the x509 stack uses them) and the SOAP XML parser.
// Every member is the same callable proxy, so module-level setup of those
// packages evaluates, and a call that would really need them returns the proxy.
const f = function () {};
const p = new Proxy(f, {
  get: (t, k) => (k === "prototype" ? t.prototype : p),
  apply: () => p,
  construct: () => p,
});
const names = [
  "cryptoProvider",
  "PemConverter",
  "ExtendedKeyUsage",
  "Pkcs10CertificateRequest",
  "X509CertificateGenerator",
  "X509Certificate",
  "AuthorityInfoAccessExtension",
  "BasicConstraintsExtension",
  "KeyUsagesExtension",
  "KeyUsageFlags",
  "Pkcs10CertificateRequestGenerator",
  "SubjectAlternativeNameExtension",
  "ExtendedKeyUsageExtension",
  "AuthorityKeyIdentifierExtension",
  "SubjectKeyIdentifierExtension",
  "PublicKey",
  "JsonGeneralNames",
  "Extension",
  "XMLParser",
  "p256",
];
const o = { default: p };
for (const n of names) o[n] = p;
module.exports = o;
