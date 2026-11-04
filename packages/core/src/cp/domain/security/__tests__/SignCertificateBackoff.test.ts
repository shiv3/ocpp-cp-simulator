import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SignCertificateBackoff } from "../SignCertificateBackoff";
import type { SignedCertificateUse } from "../certificateUse";

/**
 * #537: A02.FR.17-19 (2.0.1 and 2.1 Part 2). After the CSMS accepts a
 * SignCertificateRequest, the station resends it when no
 * CertificateSigned arrives within CertSigningWaitMinimum seconds,
 * doubling the wait each time, at most CertSigningRepeatTimes times.
 */

function setup(waitMinimumSeconds = 10, repeatTimes = 3) {
  const pending = new Set<SignedCertificateUse>([
    "ChargingStationCertificate",
    "V2GCertificate",
  ]);
  const resend = vi.fn<(use: SignedCertificateUse) => void>();
  const backoff = new SignCertificateBackoff({
    settings: () => ({ waitMinimumSeconds, repeatTimes }),
    isPending: (use) => pending.has(use),
    resend,
  });
  return { backoff, resend, pending };
}

describe("SignCertificateBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resends after W, 2W and 4W seconds, then stops (A02.FR.17-19)", () => {
    const { backoff, resend } = setup(10, 3);
    const use = "ChargingStationCertificate";

    backoff.accepted(use);
    vi.advanceTimersByTime(9_999);
    expect(resend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resend).toHaveBeenCalledTimes(1);

    // The resend's own Accepted continues the doubling.
    backoff.accepted(use);
    vi.advanceTimersByTime(19_999);
    expect(resend).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(resend).toHaveBeenCalledTimes(2);

    backoff.accepted(use);
    vi.advanceTimersByTime(40_000);
    expect(resend).toHaveBeenCalledTimes(3);

    // CertSigningRepeatTimes reached: no fourth resend.
    backoff.accepted(use);
    vi.advanceTimersByTime(10 * 60_000);
    expect(resend).toHaveBeenCalledTimes(3);
    expect(backoff.isRunning(use)).toBe(false);
  });

  it("doubles the wait every time it expires, whatever the resend's answer (A02.FR.18)", () => {
    const { backoff, resend } = setup(10, 3);
    const use = "ChargingStationCertificate";

    backoff.accepted(use);
    vi.advanceTimersByTime(10_000);
    expect(resend).toHaveBeenCalledTimes(1);
    // No answer to the resend (a CALLERROR, a lost frame): the next wait
    // still runs, twice as long.
    vi.advanceTimersByTime(19_999);
    expect(resend).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(resend).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(40_000);
    expect(resend).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(10 * 60_000);
    expect(resend).toHaveBeenCalledTimes(3);
  });

  it("waits out a doubled wait longer than a timer can hold", () => {
    const day = 24 * 3600;
    const { backoff, resend } = setup(20 * day, 2);
    const use = "ChargingStationCertificate";

    backoff.accepted(use);
    vi.advanceTimersByTime(20 * day * 1000);
    expect(resend).toHaveBeenCalledTimes(1);
    // The second wait, 40 days, is past MAX_TIMER_MS (about 24.8 days).
    vi.advanceTimersByTime(30 * day * 1000);
    expect(resend).toHaveBeenCalledTimes(1);
    expect(backoff.isRunning(use)).toBe(true);
    vi.advanceTimersByTime(10 * day * 1000 - 1);
    expect(resend).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it("does not start over on the last resend's Accepted", () => {
    const { backoff, resend } = setup(10, 1);
    const use = "ChargingStationCertificate";
    backoff.accepted(use);
    vi.advanceTimersByTime(10_000);
    expect(resend).toHaveBeenCalledTimes(1);

    backoff.accepted(use);
    vi.advanceTimersByTime(10 * 60_000);
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it("never resends when CertSigningRepeatTimes is 0", () => {
    const { backoff, resend } = setup(10, 0);
    backoff.accepted("ChargingStationCertificate");
    vi.advanceTimersByTime(60_000);
    expect(resend).not.toHaveBeenCalled();
  });

  it("stops once the CSR is no longer pending (CertificateSigned accepted)", () => {
    const { backoff, resend, pending } = setup();
    backoff.accepted("ChargingStationCertificate");
    pending.delete("ChargingStationCertificate");
    vi.advanceTimersByTime(60_000);
    expect(resend).not.toHaveBeenCalled();
    expect(backoff.isRunning("ChargingStationCertificate")).toBe(false);
  });

  it("stops on stop() (A02.FR.20: CertificateSigned rejected)", () => {
    const { backoff, resend } = setup();
    backoff.accepted("ChargingStationCertificate");
    backoff.stop("ChargingStationCertificate");
    vi.advanceTimersByTime(60_000);
    expect(resend).not.toHaveBeenCalled();
  });

  it("stops when a resend is not accepted", () => {
    const { backoff, resend } = setup();
    backoff.accepted("ChargingStationCertificate");
    vi.advanceTimersByTime(10_000);
    backoff.notAccepted("ChargingStationCertificate");
    vi.advanceTimersByTime(60_000);
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it("restarts from W when a new request is accepted (A02.FR.19 trigger)", () => {
    const { backoff, resend } = setup(10, 1);
    const use = "ChargingStationCertificate";
    backoff.accepted(use);
    vi.advanceTimersByTime(10_000);
    backoff.accepted(use);
    expect(backoff.isRunning(use)).toBe(false);

    backoff.restart(use);
    backoff.accepted(use);
    vi.advanceTimersByTime(10_000);
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it("keeps one sequence per certificate use", () => {
    const { backoff, resend } = setup(10, 3);
    backoff.accepted("ChargingStationCertificate");
    vi.advanceTimersByTime(5_000);
    backoff.accepted("V2GCertificate");
    backoff.stop("ChargingStationCertificate");
    vi.advanceTimersByTime(10_000);
    expect(resend.mock.calls).toEqual([["V2GCertificate"]]);
  });

  describe("holdAll and resumeAll (a closed connection)", () => {
    it("holds every wait, then runs what each had left", () => {
      const { backoff, resend } = setup();
      backoff.accepted("ChargingStationCertificate");
      vi.advanceTimersByTime(4_000);
      backoff.accepted("V2GCertificate");

      backoff.holdAll();
      expect(backoff.isRunning("V2GCertificate")).toBe(false);
      vi.advanceTimersByTime(60_000);
      expect(resend).not.toHaveBeenCalled();

      backoff.resumeAll();
      vi.advanceTimersByTime(5_999);
      expect(resend).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(resend.mock.calls).toEqual([["ChargingStationCertificate"]]);
      vi.advanceTimersByTime(4_000);
      expect(resend.mock.calls).toEqual([
        ["ChargingStationCertificate"],
        ["V2GCertificate"],
      ]);
    });

    it("keeps the doubling across a hold (A02.FR.18)", () => {
      const { backoff, resend } = setup(10, 3);
      const use = "ChargingStationCertificate";
      backoff.accepted(use);
      vi.advanceTimersByTime(10_000);
      expect(resend).toHaveBeenCalledTimes(1);

      backoff.holdAll();
      backoff.resumeAll();
      vi.advanceTimersByTime(19_999);
      expect(resend).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(resend).toHaveBeenCalledTimes(2);
    });

    it("does not start over a sequence past CertSigningRepeatTimes (A02.FR.19)", () => {
      const { backoff, resend } = setup(10, 1);
      const use = "ChargingStationCertificate";
      backoff.accepted(use);
      vi.advanceTimersByTime(10_000);
      expect(resend).toHaveBeenCalledTimes(1);

      backoff.holdAll();
      backoff.resumeAll();
      backoff.accepted(use);
      vi.advanceTimersByTime(10 * 60_000);
      expect(resend).toHaveBeenCalledTimes(1);
    });

    it("does not bring back a stopped sequence (A02.FR.20)", () => {
      const { backoff, resend } = setup();
      const use = "ChargingStationCertificate";
      backoff.accepted(use);
      backoff.holdAll();
      backoff.stop(use);
      backoff.resumeAll();
      vi.advanceTimersByTime(60_000);
      expect(resend).not.toHaveBeenCalled();
    });

    it("lets a new request held in between start over from W", () => {
      const { backoff, resend } = setup();
      const use = "ChargingStationCertificate";
      backoff.accepted(use);
      vi.advanceTimersByTime(9_000);
      backoff.holdAll();
      backoff.restart(use);
      backoff.resumeAll();
      vi.advanceTimersByTime(60_000);
      expect(resend).not.toHaveBeenCalled();
      backoff.accepted(use);
      vi.advanceTimersByTime(10_000);
      expect(resend).toHaveBeenCalledTimes(1);
    });

    it("resumes once when resumed twice, and not at all without a hold", () => {
      const { backoff, resend } = setup();
      const use = "ChargingStationCertificate";
      backoff.accepted(use);
      backoff.resumeAll();
      backoff.holdAll();
      backoff.resumeAll();
      backoff.resumeAll();
      vi.advanceTimersByTime(10_000);
      expect(resend).toHaveBeenCalledTimes(1);
    });
  });
});
