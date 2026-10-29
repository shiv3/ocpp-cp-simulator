import "reflect-metadata";
import * as x509 from "@peculiar/x509";

import type { Database } from "../persistence/Database";
import {
  certificateHashDataEquals,
  computeCertificateHashData,
  type CertificateHashData,
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
  | { status: "StoreFull"; limit: number };

export type DeleteCertificateOutcome =
  | { status: "Deleted"; use: RootCertificateUse | SignedCertificateUse }
  | { status: "NotFound" }
  /** M04.FR.06 (2.x) / M04.FR.05 (1.6 whitepaper): never deletable. */
  | { status: "ChargingStationCertificate" };

export type ApplySignedChainOutcome =
  | { status: "Accepted"; chain: StoredCertificateChain }
  | { status: "Malformed" }
  | { status: "NoPendingCsr" }
  | { status: "PublicKeyMismatch" };

/**
 * Safe snapshot of the store. Holds public material only (certificates and
 * CSRs); the store never retains a private key, so there is none to leak.
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
 * Private keys: `generateNewCsr` drops the generated private key (A02.FR.05,
 * it never leaves the station, and the simulator does not use it). A
 * returned chain is matched to its CSR by public key only.
 */
export class CertificateStore {
  #entries: Entry[] = [];
  #pendingCsrs = new Map<SignedCertificateUse, PendingCsr>();
  #nextSeq = 1;

  constructor(
    private readonly chargePointId: string = "",
    private readonly database: Database | null = null,
  ) {
    this.load();
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
   * The caller has already parsed every PEM.
   */
  async storeSignedChain(
    pemChain: readonly string[],
    use: SignedCertificateUse = "ChargingStationCertificate",
  ): Promise<StoredCertificateChain> {
    const chain = await this.buildChain(use, pemChain);
    this.append({ kind: "chain", seq: this.#nextSeq++, value: chain });
    return chain;
  }

  /**
   * OCPP 2.x CertificateSigned: accepts the chain only when a CSR is pending
   * for `use` and the leaf carries that CSR's public key (A02.FR.06; a
   * chain that fails is not valid for this station, A02.FR.07). On success
   * the chain replaces any older chain of the same use (A02.FR.09/10: the
   * newest certificate is the one used) and the CSR is no longer pending.
   * On failure nothing changes, the CSR stays pending.
   */
  async applySignedChain(
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

    for (const entry of this.#entries.filter(
      (e) => e.kind === "chain" && e.value.use === use,
    )) {
      this.remove(entry);
    }
    this.append({ kind: "chain", seq: this.#nextSeq++, value: chain });
    this.#pendingCsrs.delete(use);
    return { status: "Accepted", chain };
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
   * The capacity check and the insert run synchronously after the hash, so
   * concurrent installs cannot overshoot the limit. Duplicates are kept, as
   * before #456.
   */
  async installRootCertificate(
    use: RootCertificateUse,
    pem: string,
    { maxEntries }: { maxEntries: number },
  ): Promise<InstallRootCertificateOutcome> {
    const trimmed = pem.trim();
    let hashData: CertificateHashData;
    try {
      hashData = await computeCertificateHashData(trimmed);
    } catch {
      return { status: "Malformed" };
    }
    if (this.listRootCertificates().length >= maxEntries) {
      return { status: "StoreFull", limit: maxEntries };
    }
    const certificate: InstalledRootCertificate = {
      use,
      pem: trimmed,
      hashData,
      installedAt: new Date().toISOString(),
    };
    this.append({ kind: "root", seq: this.#nextSeq++, value: certificate });
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
   * `V2GCertificateChain` lists each stored `V2GCertificate` chain as its
   * leaf with the sub-CAs as children (M03.FR.05).
   */
  installedCertificateIds(
    queries?: readonly InstalledCertificateQuery[],
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
      if (e.value.use !== "V2GCertificate" || !wants("V2GCertificateChain")) {
        return [];
      }
      const [leaf, ...children] = e.value.hashData;
      return [
        { use: "V2GCertificateChain", hashData: leaf, childHashData: children },
      ];
    });
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
    return { status: "Deleted", use: entry.value.use };
  }

  clearAll(): void {
    this.#pendingCsrs.clear();
    this.#entries = [];
    this.runSafely("clear certificates", () =>
      this.database?.run("DELETE FROM certificates WHERE cp_id = ?", [
        this.chargePointId,
      ]),
    );
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

  private append(entry: Entry): void {
    this.#entries.push(entry);
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
    this.runSafely("persist certificate", () =>
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

  private remove(entry: Entry): void {
    this.#entries = this.#entries.filter((e) => e !== entry);
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

  private runSafely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`Failed to ${what}:`, err);
    }
  }
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
        hashData: body.hashData,
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
        hashData: hashData as CertificateHashData[],
        storedAt: row.installed_at,
      },
    };
  }
  return null;
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
