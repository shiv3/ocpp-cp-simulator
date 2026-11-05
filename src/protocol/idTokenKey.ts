/**
 * The lookup key of an identifier (issue #452). OCPP compares identifiers
 * without regard to case: 1.6 Part 2 §7.28 IdToken is a CiString20Type,
 * "IdToken is case insensitive", and a CiString is "Case Insensitive
 * String. Only printable ASCII allowed" (terminology); 2.0.1 and 2.1 IdTokenType.idToken says the same. Only ASCII
 * letters fold, so the key never depends on a locale or on Unicode case
 * rules.
 *
 * The Authorization Cache and the Local Authorization List key their
 * entries with it and keep the spelling received for display and the wire.
 */
export function idTokenKey(idToken: string): string {
  return idToken.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
