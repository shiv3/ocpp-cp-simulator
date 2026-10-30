import { MAX_TIMER_MS, unrefTimer } from "../../shared/timers";
import type { SignedCertificateUse } from "./certificateUse";

/** The two SecurityCtrlr variables the back-off reads on every step. */
export interface SignCertificateBackoffSettings {
  /** `CertSigningWaitMinimum`, in seconds. */
  readonly waitMinimumSeconds: number;
  /** `CertSigningRepeatTimes`: how many resends at most. */
  readonly repeatTimes: number;
}

export interface SignCertificateBackoffDeps {
  readonly settings: () => SignCertificateBackoffSettings;
  /** Whether the CSR sent for `use` still awaits its CertificateSigned. */
  readonly isPending: (use: SignedCertificateUse) => boolean;
  /** Sends the SignCertificateRequest for `use` again, same CSR. */
  readonly resend: (use: SignedCertificateUse) => void;
}

interface Sequence {
  /** Resends sent so far. */
  resends: number;
  /** The wait in progress; none once `CertSigningRepeatTimes` is reached. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The SignCertificate resend back-off of OCPP 2.0.1 / 2.1 A02.FR.17-19
 * (#537), one sequence per certificate use:
 *
 * - an accepted SignCertificateRequest starts a wait of
 *   `CertSigningWaitMinimum` seconds (A02.FR.17);
 * - every time the wait expires and the CSR still awaits its
 *   CertificateSigned, the request is resent and the next wait, twice as
 *   long, starts at once (A02.FR.18): a resend left unanswered or answered
 *   with a CALLERROR does not stall the sequence;
 * - after `CertSigningRepeatTimes` resends the station stops until the
 *   CSMS triggers a new request (A02.FR.19). The sequence is kept, with no
 *   wait, so the last resend's answer does not start it over.
 *
 * Every new request (TriggerMessage, `sign_certificate`) calls
 * {@link restart} first, so an `Accepted` seen while a sequence exists is
 * a resend's. The owner stops a sequence when CertificateSigned is
 * rejected (A02.FR.20) and every sequence when the connection closes.
 */
export class SignCertificateBackoff {
  readonly #sequences = new Map<SignedCertificateUse, Sequence>();

  constructor(private readonly deps: SignCertificateBackoffDeps) {}

  /** The CSMS accepted a SignCertificateRequest for `use`. */
  accepted(use: SignedCertificateUse): void {
    // A resend's answer: the next wait already runs since the expiry.
    if (this.#sequences.has(use)) return;
    if (this.deps.settings().repeatTimes <= 0) return;
    const sequence: Sequence = { resends: 0 };
    this.#sequences.set(use, sequence);
    this.schedule(use, sequence);
  }

  /** The CSMS did not accept a SignCertificateRequest for `use`. */
  notAccepted(use: SignedCertificateUse): void {
    this.stop(use);
  }

  /** A new request for `use` is about to be sent (TriggerMessage,
   *  `sign_certificate`): its sequence starts over once accepted. */
  restart(use: SignedCertificateUse): void {
    this.stop(use);
  }

  stop(use: SignedCertificateUse): void {
    const sequence = this.#sequences.get(use);
    if (sequence?.timer !== undefined) clearTimeout(sequence.timer);
    this.#sequences.delete(use);
  }

  stopAll(): void {
    for (const use of [...this.#sequences.keys()]) this.stop(use);
  }

  /** Whether a wait for `use` is in progress. */
  isRunning(use: SignedCertificateUse): boolean {
    return this.#sequences.get(use)?.timer !== undefined;
  }

  private schedule(use: SignedCertificateUse, sequence: Sequence): void {
    const seconds =
      this.deps.settings().waitMinimumSeconds * 2 ** sequence.resends;
    const timer = setTimeout(
      () => this.expire(use, sequence),
      Math.min(seconds * 1000, MAX_TIMER_MS),
    );
    // A pending wait must not keep a CLI process alive on its own.
    unrefTimer(timer);
    sequence.timer = timer;
  }

  private expire(use: SignedCertificateUse, sequence: Sequence): void {
    if (this.#sequences.get(use) !== sequence) return;
    sequence.timer = undefined;
    if (!this.deps.isPending(use)) {
      this.stop(use);
      return;
    }
    sequence.resends++;
    this.deps.resend(use);
    // A02.FR.18: the doubled wait starts now, whatever the answer.
    if (
      this.#sequences.get(use) === sequence &&
      sequence.resends < this.deps.settings().repeatTimes
    ) {
      this.schedule(use, sequence);
    }
  }
}
