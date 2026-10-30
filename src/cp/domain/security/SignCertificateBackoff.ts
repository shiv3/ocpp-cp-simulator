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
  /** A resend is on the wire and its answer is awaited. */
  awaitingResendAnswer: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The SignCertificate resend back-off of OCPP 2.0.1 / 2.1 A02.FR.17-19
 * (#537), one sequence per certificate use:
 *
 * - an accepted SignCertificateRequest starts a wait of
 *   `CertSigningWaitMinimum` seconds (A02.FR.17);
 * - when it expires and the CSR still awaits its CertificateSigned, the
 *   request is resent, and the wait doubles once the resend is accepted
 *   (A02.FR.18);
 * - after `CertSigningRepeatTimes` resends the station stops until the
 *   CSMS triggers a new request (A02.FR.19), which {@link restart}s it.
 *
 * The owner stops a sequence when CertificateSigned is rejected
 * (A02.FR.20) and every sequence when the connection closes.
 */
export class SignCertificateBackoff {
  readonly #sequences = new Map<SignedCertificateUse, Sequence>();

  constructor(private readonly deps: SignCertificateBackoffDeps) {}

  /** The CSMS accepted a SignCertificateRequest for `use`. */
  accepted(use: SignedCertificateUse): void {
    const current = this.#sequences.get(use);
    if (current?.awaitingResendAnswer) {
      current.awaitingResendAnswer = false;
      if (current.resends >= this.deps.settings().repeatTimes) {
        this.stop(use);
        return;
      }
      this.schedule(use, current);
      return;
    }
    // A new request: its sequence starts over.
    this.stop(use);
    if (this.deps.settings().repeatTimes <= 0) return;
    const sequence: Sequence = { resends: 0, awaitingResendAnswer: false };
    this.#sequences.set(use, sequence);
    this.schedule(use, sequence);
  }

  /** The CSMS did not accept a SignCertificateRequest for `use`. */
  notAccepted(use: SignedCertificateUse): void {
    this.stop(use);
  }

  /** A new request for `use` is about to be sent (TriggerMessage). */
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

  isRunning(use: SignedCertificateUse): boolean {
    return this.#sequences.has(use);
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
    sequence.awaitingResendAnswer = true;
    this.deps.resend(use);
  }
}
