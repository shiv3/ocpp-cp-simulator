/**
 * WebCrypto dictionary types for the CLI project.
 *
 * Bun implements WebCrypto (`crypto.subtle`), but `bun-types` does not
 * declare its dictionary types (`Algorithm`, `EcKeyGenParams`, …) as globals
 * the way the DOM lib does, and the CLI project deliberately does not load
 * the DOM lib. `@peculiar/x509` and `src/cp/domain/security` refer to them
 * globally, so alias the ones in use to Node's `webcrypto` namespace. In the
 * web app project these merge with the identical DOM declarations.
 */
import type { webcrypto } from "node:crypto";

declare global {
  interface Algorithm extends webcrypto.Algorithm {}
  interface KeyAlgorithm extends webcrypto.KeyAlgorithm {}
  interface EcKeyAlgorithm extends webcrypto.EcKeyAlgorithm {}
  interface EcKeyGenParams extends webcrypto.EcKeyGenParams {}
  interface RsaKeyAlgorithm extends webcrypto.RsaKeyAlgorithm {}
  interface RsaHashedKeyGenParams extends webcrypto.RsaHashedKeyGenParams {}
}
