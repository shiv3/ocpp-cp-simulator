import "reflect-metadata";
import * as x509 from "@peculiar/x509";

import type { Database } from "../persistence/Database";
import {
  bytesEqual,
  certificateHashDataEquals,
  computeCertificateHashData,
  normalizeSerialNumber,
  ocspResponderUrl,
  type CertificateHashData,
  type OcspRequestData,
} from "./certificateHash";
import {
  isRootCertificateUse,
  isSignedCertificateUse,
  type InstalledCertificateQuery,
  type RootCertificateUse,
  type SignedCertificateUse,
} from "./certificateUse";
import { generateCsr, type CsrGenerationOptions } from "./csr";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

/** Hash data as a CSMS sends it: any algorithm name, any hex casing. */
export interface CertificateHashDataLike {
  hashAlgorithm: string;
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
}

/** A trust anchor installed through InstallCertificate (M05). */
export interface InstalledRootCertificate {
  readonly use: RootCertificateUse;
  /** Trimmed PEM, as received. */
  readonly pem: string;
  /** Computed once at install time, so lookups stay synchronous. */
  readonly hashData: CertificateHashData;
  readonly installedAt: string;
}

/** A certificate chain received through CertificateSigned (A02 / A03). */
export interface StoredCertificateChain {
  readonly use: SignedCertificateUse;
  /** Leaf first, then its sub-CAs, each trimmed. */
  readonly pems: readonly string[];
  /** One entry per `pems` element, hashed against that element's issuer. */
  readonly hashData: readonly CertificateHashData[];
  readonly storedAt: string;
}

/** One GetInstalledCertificateIds entry, version-neutral (M03). */
export interface InstalledCertificateIds {
  readonly use: InstalledCertificateQuery;
  readonly hashData: CertificateHashData;
  /** Sub-CA hash data under a V2G leaf (M03.FR.05); empty for roots. */
  readonly childHashData: readonly CertificateHashData[];
}

export type InstallRootCertificateOutcome =
  | { status: "Installed"; certificate: InstalledRootCertificate }
  | { status: "Malformed" }
  | { status: "StoreFull"; limit: number }
  /** The database refused the row; nothing was installed. */
  | { status: "PersistFailed" };

export interface InstallRootCertificateOptions {
  /** Roots the store may hold (signed chains do not count). */
  maxEntries: number;
  /**
   * Replace an installed root with the same hash data instead of adding a
   * second copy (2.x M05.FR.17). The replaced root does not count against
   * `maxEntries`. Off by default: 1.6 keeps duplicates.
   */
  replaceDuplicate?: boolean;
}

export type DeleteCertificateOutcome =
  | { status: "Deleted"; use: RootCertificateUse | SignedCertificateUse }
  | { status: "NotFound" }
  /** M04.FR.06 (2.x) / M04.FR.05 (1.6 whitepaper): never deletable. */
  | { status: "ChargingStationCertificate" };

/** An OCSP response cached for one certificate (2.x M06, #537). */
export interface CachedOcspResponse {
  /** Base64 DER OCSPResponse, as the CSMS sent it. */
  readonly ocspResult: string;
  readonly cachedAt: string;
}

export type ApplySignedChainOutcome =
  | { status: "Accepted"; chain: StoredCertificateChain }
  | { status: "Malformed" }
  | { status: "NoPendingCsr" }
  | { status: "PublicKeyMismatch" };

/**
 * Safe snapshot of the store. Holds public material only (certificates and
 * CSRs): the private keys the store holds in memory (#537) are left out.
 */
export interface CertificateStoreJson {
  pendingCsrs: { use: SignedCertificateUse; pem: string }[];
  rootCerts: InstalledRootCertificate[];
  /** PEMs of each stored chain, leaf first (kept for the 1.6 tests). */
  signedChains: string[][];
}

interface PendingCsr {
  readonly pem: string;
  /** DER SubjectPublicKeyInfo of the CSR, compared with a returned leaf. */
  readonly publicKey: Uint8Array;
  /** The key pair's private half, when the store generated the CSR (#537).
   *  Memory-only; absent for a CSR forwarded by the caller. */
  readonly privateKey?: CryptoKey;
}

/** A signed Charging Station certificate the station can present as its
 *  TLS client identity (#537, A02.FR.08). */
export interface TlsClientIdentity {
  /** The stored chain, leaf first, as PEM. */
  readonly cert: string;
  /** The leaf's PKCS#8 private key, as PEM. */
  readonly key: string;
  /** The leaf's `notBefore`: the station switches once it has passed. */
  readonly notBefore: Date;
}

type Entry =
  | { kind: "root"; seq: number; value: InstalledRootCertificate }
  | { kind: "chain"; seq: number; value: StoredCertificateChain };

interface CertificateRow {
  seq: number;
  kind: string;
  certificate_use: string;
  body: string;
  installed_at: string;
}

/**
 * The station's certificate state (OCPP 1.6 Security Whitepaper, 2.0.1 and
 * 2.1 use cases A02/A03 and M03-M05), in version-neutral terms. Transport
 * adapters map the wire enums onto {@link RootCertificateUse} /
 * {@link SignedCertificateUse} and the outcomes onto their own statuses.
 *
 * Installed roots and signed chains are backed by the `certificates` table
 * when a {@link Database} is given (state persistence, #456) and kept in
 * memory otherwise. Pending CSRs are memory-only: the key pair behind a CSR
 * does not survive a restart, and A02.FR.17 has the station send a new CSR
 * when no CertificateSigned arrives for the previous one.
 *
 * Private keys (A02.FR.05: they never leave the station): `generateNewCsr`
 * keeps the generated private key in memory with the pending CSR. When the
 * signed chain is accepted, the key stays bound to that chain's leaf, so
 * the station can present it as its TLS client identity (#537,
 * {@link tlsClientIdentity}). Neither is ever persisted or serialized; a
 * restart loses both. A returned chain is matched to its CSR by public key.
 *
 * Ordering: installs and signed-chain updates hash asynchronously, so they
 * run one at a time through {@link runExclusive}. A transport handler that
 * reads or deletes runs its work through `runExclusive` too, so a query
 * issued after an install observes that install even though the transport
 * dispatches CALLs without waiting for each other.
 */
export class CertificateStore {
  #entries: Entry[] = [];
  #pendingCsrs = new Map<SignedCertificateUse, PendingCsr>();
  /** Private keys of accepted chains, by leaf PEM (#537). Memory-only. */
  #chainKeys = new Map<string, CryptoKey>();
  #nextSeq = 1;
  /** Settles once every operation queued so far has completed. */
  #tail: Promise<void> = Promise.resolve();
  #pendingOperations = 0;
  #listeners = new Set<() => void>();
  #ocspResponses: {
    hash: CertificateHashDataLike;
    ocspResult: string;
    cachedAt: string;
  }[] = [];

  constructor(
    private readonly chargePointId: string = "",
    private readonly database: Database | null = null,
  ) {
    this.load();
  }

  /**
   * Calls `listener` after every change to the installed roots or stored
   * chains (#537: the 2.x `CertificateEntries` count). Pending CSRs do not
   * count. Returns the unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  private notifyChanged(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (err) {
        console.error("Certificate store listener threw:", err);
      }
    }
  }

  // ── Ordering ────────────────────────────────────────────────────────────

  /**
   * Runs `op` once every certificate operation started before it has
   * completed. When none is pending, `op` runs at once and a synchronous
   * result is returned synchronously (a 2.x query then still answers in
   * the tick of its CALL). An operation that throws or rejects does not
   * block the ones after it. `op` must not call `runExclusive` itself.
   */
  runExclusive<T>(op: () => T): T | Promise<Awaited<T>> {
    if (this.#pendingOperations === 0) {
      const result = op();
      if (!isPromiseLike(result)) return result;
      return this.track(Promise.resolve(result));
    }
    return this.track(this.#tail.then(op) as Promise<Awaited<T>>);
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.#pendingOperations++;
    const done = (): void => {
      this.#pendingOperations--;
    };
    this.#tail = operation.then(done, done);
    return operation;
  }

  // ── CSR (A02 / A03) ─────────────────────────────────────────────────────

  async generateNewCsr(
    serial: string,
    cpoName: string,
    options?: CsrGenerationOptions,
    use: SignedCertificateUse = "ChargingStationCertificate",
  ): Promise<string> {
    const generated = await generateCsr(serial, cpoName, options);
    this.#pendingCsrs.set(use, {
      pem: generated.pem,
      publicKey: new Uint8Array(generated.csr.publicKey.rawData),
      privateKey: generated.privateKey,
    });
    return generated.pem;
  }

  /**
   * Records a CSR the station did not generate itself (one forwarded by
   * `sendSignCertificate(csr)`). Returns `false`, and keeps any previous
   * pending CSR, when `pem` is not a parseable PKCS#10 request.
   */
  recordPendingCsr(use: SignedCertificateUse, pem: string): boolean {
    try {
      const csr = new x509.Pkcs10CertificateRequest(pem);
      this.#pendingCsrs.set(use, {
        pem,
        publicKey: new Uint8Array(csr.publicKey.rawData),
      });
      return true;
    } catch {
      return false;
    }
  }

  pendingCsr(use: SignedCertificateUse): string | undefined {
    return this.#pendingCsrs.get(use)?.pem;
  }

  // ── Signed chains ───────────────────────────────────────────────────────

  /**
   * OCPP 1.6 CertificateSigned: stores the chain unconditionally, without
   * consulting or clearing the pending CSR (the 1.6 behaviour before #456).
   * It replaces the previous chain of the same use, so persisted rows do
   * not pile up; no 1.6 message reads signed chains back. The caller has
   * already parsed every PEM.
   */
  storeSignedChain(
    pemChain: readonly string[],
    use: SignedCertificateUse = "ChargingStationCertificate",
  ): Promise<StoredCertificateChain> {
    return this.runExclusive(async () => {
      const chain = await this.buildChain(use, pemChain);
      this.replaceChains(use, chain);
      return chain;
    });
  }

  /**
   * OCPP 2.x CertificateSigned: accepts the chain only when a CSR is pending
   * for `use` and the leaf carries that CSR's public key (A02.FR.06; a
   * chain that fails is not valid for this station, A02.FR.07). On success
   * the chain replaces any older chain of the same use (A02.FR.09/10: the
   * newest certificate is the one used) and the CSR is no longer pending.
   * On failure nothing changes, the CSR stays pending.
   */
  applySignedChain(
    use: SignedCertificateUse,
    pemChain: readonly string[],
  ): Promise<ApplySignedChainOutcome> {
    return this.runExclusive(() => this.applySignedChainNow(use, pemChain));
  }

  private async applySignedChainNow(
    use: SignedCertificateUse,
    pemChain: readonly string[],
  ): Promise<ApplySignedChainOutcome> {
    if (pemChain.length === 0) return { status: "Malformed" };
    let chain: StoredCertificateChain;
    let leafKey: Uint8Array;
    try {
      chain = await this.buildChain(use, pemChain);
      leafKey = new Uint8Array(
        new x509.X509Certificate(chain.pems[0]).publicKey.rawData,
      );
    } catch {
      return { status: "Malformed" };
    }
    const pending = this.#pendingCsrs.get(use);
    if (!pending) return { status: "NoPendingCsr" };
    if (!bytesEqual(pending.publicKey, leafKey)) {
      return { status: "PublicKeyMismatch" };
    }

    // Bound before the change is announced, so a listener reading
    // tlsClientIdentity() sees the new chain with its key. The leaf is
    // new (its CSR's key pair is), so no chain replaced below shares it.
    if (pending.privateKey) {
      this.#chainKeys.set(chain.pems[0], pending.privateKey);
    }
    this.replaceChains(use, chain);
    this.#pendingCsrs.delete(use);
    return { status: "Accepted", chain };
  }

  /**
   * The current Charging Station certificate chain with its private key
   * (#537, A02.FR.08), or `undefined` when there is no such chain or the
   * store does not hold its key: a chain signed for a CSR the caller
   * supplied, one stored by 1.6 CertificateSigned, or any chain read back
   * after a restart. The key is exported for the TLS handshake only; the
   * caller must not log or persist it. A chain replaced while its key is
   * exported is not returned: the answer is the chain current once the
   * export completes.
   */
  async tlsClientIdentity(): Promise<TlsClientIdentity | undefined> {
    for (;;) {
      const { chain, privateKey } = this.currentClientChain();
      if (!chain || !privateKey) return undefined;
      const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
      const [current] = this.listSignedChains("ChargingStationCertificate");
      if (current?.pems[0] !== chain.pems[0]) continue;
      if (this.#chainKeys.get(chain.pems[0]) !== privateKey) continue;
      return {
        cert: current.pems.map((pem) => `${pem}\n`).join(""),
        key: `${x509.PemConverter.encode(pkcs8, "PRIVATE KEY")}\n`,
        notBefore: new x509.X509Certificate(chain.pems[0]).notBefore,
      };
    }
  }

  /** Whether {@link tlsClientIdentity} has an identity to export, without
   *  exporting the key. */
  hasTlsClientIdentity(): boolean {
    return this.currentClientChain().privateKey !== undefined;
  }

  /** The current Charging Station certificate chain and the key bound to
   *  its leaf, if the store holds one. */
  private currentClientChain(): {
    chain?: StoredCertificateChain;
    privateKey?: CryptoKey;
  } {
    const [chain] = this.listSignedChains("ChargingStationCertificate");
    return { chain, privateKey: chain && this.#chainKeys.get(chain.pems[0]) };
  }

  /**
   * Drops every private key the store holds in memory (#537): those of
   * accepted chains and of pending CSRs. Chains, roots and CSRs stay, as
   * after a restart. Called when the charge point owning the store is
   * replaced (`cp.update`), so a discarded instance keeps no key.
   */
  forgetPrivateKeys(): void {
    this.#chainKeys.clear();
    for (const [use, pending] of this.#pendingCsrs) {
      if (pending.privateKey) {
        this.#pendingCsrs.set(use, {
          pem: pending.pem,
          publicKey: pending.publicKey,
        });
      }
    }
  }

  // ── OCSP (2.x M06, #537) ────────────────────────────────────────────────

  /**
   * GetCertificateStatus `ocspRequestData` for every member of the stored
   * `use` chain, leaf first, whose certificate names an OCSP responder
   * (M06.FR.07: the certificate and its sub-CAs). A member without one is
   * left out: OCPP requires a responderURL.
   */
  ocspRequestData(use: SignedCertificateUse): OcspRequestData[] {
    return this.listSignedChains(use).flatMap((chain) =>
      chain.pems.flatMap((pem, i): OcspRequestData[] => {
        const responderURL = ocspResponderUrl(pem);
        return responderURL ? [{ ...chain.hashData[i], responderURL }] : [];
      }),
    );
  }

  /** Caches the OCSP response a CSMS returned for `hash` (M06.FR.06),
   *  replacing an older one. Memory-only; dropped with the chain holding
   *  the certificate. */
  cacheOcspResponse(hash: CertificateHashDataLike, ocspResult: string): void {
    this.#ocspResponses = [
      ...this.#ocspResponses.filter(
        (entry) => !certificateHashDataEquals(entry.hash, hash),
      ),
      { hash: { ...hash }, ocspResult, cachedAt: new Date().toISOString() },
    ];
  }

  cachedOcspResponse(
    hash: CertificateHashDataLike,
  ): CachedOcspResponse | undefined {
    const entry = this.#ocspResponses.find((e) =>
      certificateHashDataEquals(e.hash, hash),
    );
    return entry && { ocspResult: entry.ocspResult, cachedAt: entry.cachedAt };
  }

  listSignedChains(use?: SignedCertificateUse): StoredCertificateChain[] {
    return this.#entries.flatMap((e) =>
      e.kind === "chain" && (use === undefined || e.value.use === use)
        ? [e.value]
        : [],
    );
  }

  // ── Trust anchors (M05 / M03 / M04) ─────────────────────────────────────

  /**
   * Installs a root after parsing and hashing it. `StoreFull` when the
   * store already holds `maxEntries` roots (signed chains do not count).
   * Installs run one at a time ({@link runExclusive}), so concurrent ones
   * cannot overshoot the limit. Duplicates are kept, as before #456, unless
   * `replaceDuplicate` is set. `PersistFailed` when the database refuses
   * the row: the store then keeps its previous content, so a certificate
   * answered as installed is one that survives a restart.
   */
  installRootCertificate(
    use: RootCertificateUse,
    pem: string,
    options: InstallRootCertificateOptions,
  ): Promise<InstallRootCertificateOutcome> {
    return this.runExclusive(() =>
      this.installRootCertificateNow(use, pem, options),
    );
  }

  private async installRootCertificateNow(
    use: RootCertificateUse,
    pem: string,
    { maxEntries, replaceDuplicate = false }: InstallRootCertificateOptions,
  ): Promise<InstallRootCertificateOutcome> {
    const trimmed = pem.trim();
    let hashData: CertificateHashData;
    try {
      hashData = await computeCertificateHashData(trimmed);
    } catch {
      return { status: "Malformed" };
    }
    const duplicate = replaceDuplicate
      ? this.#entries.find(
          (e) =>
            e.kind === "root" &&
            certificateHashDataEquals(e.value.hashData, hashData),
        )
      : undefined;
    const kept = this.listRootCertificates().length - (duplicate ? 1 : 0);
    if (kept >= maxEntries) {
      return { status: "StoreFull", limit: maxEntries };
    }
    const certificate: InstalledRootCertificate = {
      use,
      pem: trimmed,
      hashData,
      installedAt: new Date().toISOString(),
    };
    const entry: Entry = {
      kind: "root",
      seq: this.#nextSeq++,
      value: certificate,
    };
    if (!this.persist(entry)) return { status: "PersistFailed" };
    this.#entries.push(entry);
    if (duplicate) this.remove(duplicate);
    this.notifyChanged();
    return { status: "Installed", certificate };
  }

  /** Installed roots in install order, optionally limited to `uses`. */
  listRootCertificates(
    uses?: readonly RootCertificateUse[],
  ): InstalledRootCertificate[] {
    return this.#entries.flatMap((e) =>
      e.kind === "root" && (uses === undefined || uses.includes(e.value.use))
        ? [e.value]
        : [],
    );
  }

  /**
   * GetInstalledCertificateIds, version-neutral. `queries` absent means
   * every installed certificate (2.x omits `certificateType` for "all").
   * `V2GCertificateChain` lists each stored chain of a `v2gChainUses` use
   * as its leaf with the sub-CAs as children (M03.FR.05). The default is
   * 2.0.1's single V2G certificate; 2.1 adds `V2G20Certificate` (#537).
   */
  installedCertificateIds(
    queries?: readonly InstalledCertificateQuery[],
    v2gChainUses: readonly SignedCertificateUse[] = ["V2GCertificate"],
  ): InstalledCertificateIds[] {
    const wants = (q: InstalledCertificateQuery) =>
      queries === undefined || queries.includes(q);
    return this.#entries.flatMap((e): InstalledCertificateIds[] => {
      if (e.kind === "root") {
        return wants(e.value.use)
          ? [
              {
                use: e.value.use,
                hashData: e.value.hashData,
                childHashData: [],
              },
            ]
          : [];
      }
      if (
        !v2gChainUses.includes(e.value.use) ||
        !wants("V2GCertificateChain")
      ) {
        return [];
      }
      const [leaf, ...children] = e.value.hashData;
      return [
        { use: "V2GCertificateChain", hashData: leaf, childHashData: children },
      ];
    });
  }

  /** The first installed root matching `hash`, the one a delete removes. */
  findRootCertificate(
    hash: CertificateHashDataLike,
  ): InstalledRootCertificate | undefined {
    return this.listRootCertificates().find((root) =>
      certificateHashDataEquals(root.hashData, hash),
    );
  }

  /**
   * Trust-store delete (the OCPP 1.6 DeleteCertificate scope): removes the
   * first installed root matching `hash`. Signed chains are not searched.
   */
  deleteRootCertificate(
    hash: CertificateHashDataLike,
  ): InstalledRootCertificate | undefined {
    const entry = this.#entries.find(
      (e) =>
        e.kind === "root" && certificateHashDataEquals(e.value.hashData, hash),
    );
    if (!entry || entry.kind !== "root") return undefined;
    this.remove(entry);
    this.notifyChanged();
    return entry.value;
  }

  /**
   * DeleteCertificate over everything the station holds (2.x, M04): the
   * first matching root, else a stored chain one of whose members matches.
   * A ChargingStationCertificate chain is refused (M04.FR.06); any other
   * chain is removed whole, sub-CAs included (M04.FR.08 allows it).
   */
  deleteCertificate(hash: CertificateHashDataLike): DeleteCertificateOutcome {
    const root = this.deleteRootCertificate(hash);
    if (root) return { status: "Deleted", use: root.use };
    const entry = this.#entries.find(
      (e) =>
        e.kind === "chain" &&
        e.value.hashData.some((h) => certificateHashDataEquals(h, hash)),
    );
    if (!entry) return { status: "NotFound" };
    if (entry.value.use === "ChargingStationCertificate") {
      return { status: "ChargingStationCertificate" };
    }
    this.remove(entry);
    this.notifyChanged();
    return { status: "Deleted", use: entry.value.use };
  }

  clearAll(): void {
    this.#pendingCsrs.clear();
    this.#chainKeys.clear();
    this.#ocspResponses = [];
    this.#entries = [];
    this.runSafely("clear certificates", () =>
      this.database?.run("DELETE FROM certificates WHERE cp_id = ?", [
        this.chargePointId,
      ]),
    );
    this.notifyChanged();
  }

  toJSON(): CertificateStoreJson {
    return {
      pendingCsrs: [...this.#pendingCsrs].map(([use, csr]) => ({
        use,
        pem: csr.pem,
      })),
      rootCerts: this.listRootCertificates(),
      signedChains: this.listSignedChains().map((chain) => [...chain.pems]),
    };
  }

  toString(): string {
    return JSON.stringify(this.toJSON());
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Hashes each chain member against its issuer: the next member when its
   * subject is the issuer, else an installed root with that subject, else
   * the member itself (self-signed, or an issuer the station does not hold;
   * issuerKeyHash is then an approximation).
   */
  private async buildChain(
    use: SignedCertificateUse,
    pemChain: readonly string[],
  ): Promise<StoredCertificateChain> {
    const pems = pemChain.map((pem) => pem.trim());
    const certs = pems.map((pem) => new x509.X509Certificate(pem));
    const hashData = await Promise.all(
      certs.map((cert, i) => {
        const next = certs[i + 1];
        const issuerPem =
          next && next.subject === cert.issuer
            ? pems[i + 1]
            : this.listRootCertificates().find(
                (root) =>
                  new x509.X509Certificate(root.pem).subject === cert.issuer,
              )?.pem;
        return computeCertificateHashData(pems[i], issuerPem);
      }),
    );
    return { use, pems, hashData, storedAt: new Date().toISOString() };
  }

  /**
   * Stores `chain` in place of every chain of the same use. A chain the
   * database refuses is still kept in memory (logged): CertificateSigned
   * has no status for a station-side failure.
   */
  private replaceChains(
    use: SignedCertificateUse,
    chain: StoredCertificateChain,
  ): void {
    for (const entry of this.#entries.filter(
      (e) => e.kind === "chain" && e.value.use === use,
    )) {
      this.remove(entry, { pruneOcsp: false });
    }
    const entry: Entry = { kind: "chain", seq: this.#nextSeq++, value: chain };
    this.persist(entry);
    this.#entries.push(entry);
    // After the push: a sub-CA the new chain shares keeps its response.
    this.pruneOcspResponses();
    this.notifyChanged();
  }

  /** INSERTs `entry`; `false` (logged) when the database refuses it. */
  private persist(entry: Entry): boolean {
    const [body, installedAt] =
      entry.kind === "root"
        ? [
            { pem: entry.value.pem, hashData: entry.value.hashData },
            entry.value.installedAt,
          ]
        : [
            { pems: entry.value.pems, hashData: entry.value.hashData },
            entry.value.storedAt,
          ];
    return this.runSafely("persist certificate", () =>
      this.database?.run(
        "INSERT INTO certificates (cp_id, seq, kind, certificate_use, body, installed_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
        [
          this.chargePointId,
          entry.seq,
          entry.kind,
          entry.value.use,
          JSON.stringify(body),
          installedAt,
        ],
      ),
    );
  }

  /** Drops cached OCSP responses no stored chain member matches any more. */
  private pruneOcspResponses(): void {
    const stored = this.listSignedChains().flatMap((chain) => chain.hashData);
    this.#ocspResponses = this.#ocspResponses.filter((cached) =>
      stored.some((h) => certificateHashDataEquals(h, cached.hash)),
    );
  }

  private remove(entry: Entry, { pruneOcsp = true } = {}): void {
    this.#entries = this.#entries.filter((e) => e !== entry);
    if (entry.kind === "chain") {
      this.#chainKeys.delete(entry.value.pems[0]);
      if (pruneOcsp) this.pruneOcspResponses();
    }
    this.runSafely("delete certificate", () =>
      this.database?.run(
        "DELETE FROM certificates WHERE cp_id = ? AND seq = ?",
        [this.chargePointId, entry.seq],
      ),
    );
  }

  private load(): void {
    if (!this.database) return;
    let rows: CertificateRow[];
    try {
      rows = this.database.all<CertificateRow>(
        "SELECT seq, kind, certificate_use, body, installed_at FROM certificates " +
          "WHERE cp_id = ? ORDER BY seq ASC",
        [this.chargePointId],
      );
    } catch (err) {
      console.error("Failed to load installed certificates:", err);
      return;
    }
    for (const row of rows) {
      this.#nextSeq = Math.max(this.#nextSeq, row.seq + 1);
      const entry = rowToEntry(row);
      if (entry) this.#entries.push(entry);
      else console.error(`Skipping unreadable certificate row seq=${row.seq}`);
    }
  }

  /** Runs a database write; `false` (logged) when it throws. */
  private runSafely(what: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      console.error(`Failed to ${what}:`, err);
      return false;
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

function rowToEntry(row: CertificateRow): Entry | null {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.body);
    if (typeof parsed !== "object" || parsed === null) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (row.kind === "root" && isRootCertificateUse(row.certificate_use)) {
    if (typeof body.pem !== "string" || !isHashData(body.hashData)) return null;
    return {
      kind: "root",
      seq: row.seq,
      value: {
        use: row.certificate_use,
        pem: body.pem,
        hashData: normalizeHashData(body.hashData),
        installedAt: row.installed_at,
      },
    };
  }
  if (row.kind === "chain" && isSignedCertificateUse(row.certificate_use)) {
    const { pems, hashData } = body;
    if (
      !Array.isArray(pems) ||
      pems.length === 0 ||
      !pems.every((p) => typeof p === "string") ||
      !Array.isArray(hashData) ||
      hashData.length !== pems.length ||
      !hashData.every(isHashData)
    ) {
      return null;
    }
    return {
      kind: "chain",
      seq: row.seq,
      value: {
        use: row.certificate_use,
        pems: pems as string[],
        hashData: (hashData as CertificateHashData[]).map(normalizeHashData),
        storedAt: row.installed_at,
      },
    };
  }
  return null;
}

/**
 * Rows written before #537 hold the serialNumber with its leading zero;
 * they are read back in the current form, so GetInstalledCertificateIds
 * reports one form whatever the row's age.
 */
function normalizeHashData(hash: CertificateHashData): CertificateHashData {
  return { ...hash, serialNumber: normalizeSerialNumber(hash.serialNumber) };
}

function isHashData(value: unknown): value is CertificateHashData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.hashAlgorithm === "SHA256" &&
    typeof v.issuerNameHash === "string" &&
    typeof v.issuerKeyHash === "string" &&
    typeof v.serialNumber === "string"
  );
}
