// Real GetLog uploads (#926): OCPP 1.6 Security Whitepaper and 2.x, on the
// virtual clock, with an injected uploader standing for the CSMS endpoint.
import { afterEach, describe, expect, test } from "bun:test";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { FileUploader } from "../../cp/domain/charge-point/FileUploader";
import { LogType } from "../../cp/shared/Logger";
import { runBehavior, type BehaviorRun } from "./runBehavior";

let run: BehaviorRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

interface Upload {
  url: string;
  name: string;
  text: string;
}

/** A station with RealLogUpload on and `uploader` as the HTTP PUT. */
async function station(
  version: "1.6" | "2.0.1" | "2.1",
  uploader: FileUploader,
  config: Record<string, string> = {},
): Promise<BehaviorRun> {
  return runBehavior({
    version,
    beforeConnect: (cp: ChargePoint) => {
      Object.defineProperty(cp, "logUploader", { get: () => uploader });
      cp.configuration.applyChange("RealLogUpload", "true", { operator: true });
      for (const [k, v] of Object.entries(config)) {
        cp.configuration.applyChange(k, v, { operator: true });
      }
    },
  });
}

const okUploader =
  (uploads: Upload[]): FileUploader =>
  async (url, file) => {
    uploads.push({ url, name: file.name, text: await file.text() });
    return { ok: true, status: 200 };
  };

const getLog = (requestId: number, extra: Record<string, unknown> = {}) => ({
  logType: "DiagnosticsLog",
  requestId,
  log: { remoteLocation: "https://csms.example/logs/up" },
  ...extra,
});
const reply = (f: { payload: unknown }) =>
  (f.payload as { status?: string }).status;
const notes = (r: BehaviorRun) =>
  r
    .callsOf("LogStatusNotification")
    .map((f) => f.payload as { status: string; requestId?: number });

describe.each(["1.6", "2.0.1", "2.1"] as const)(
  "real GetLog upload (%s)",
  (version) => {
    const withId = version === "1.6" ? "requestId" : "requestId";

    test("Accepted, then Uploading and Uploaded only after the file was sent", async () => {
      const uploads: Upload[] = [];
      run = await station(version, okUploader(uploads));
      run.cp.logger.enableTypes(LogType.GENERAL);
      run.cp.logger.info("hello from the log", LogType.GENERAL);
      const answer = await run.call("GetLog", getLog(7));
      expect(reply(answer)).toBe("Accepted");
      expect((answer.payload as { filename: string }).filename).toMatch(
        /-DiagnosticsLog-7\.jsonl$/,
      );
      await run.advance(100);
      expect(uploads).toHaveLength(1);
      expect(uploads[0]!.url).toBe("https://csms.example/logs/up");
      expect(uploads[0]!.text).toContain("hello from the log");
      expect(
        uploads[0]!.text
          .trim()
          .split("\n")
          .every((l) => JSON.parse(l)),
      ).toBe(true);
      expect(notes(run)).toEqual([
        { status: "Uploading", [withId]: 7 },
        { status: "Uploaded", [withId]: 7 },
      ]);
    });

    test("an HTTP failure ends in UploadFailure after the retries, never Uploaded", async () => {
      let calls = 0;
      run = await station(version, async () => {
        calls++;
        return { ok: false, status: 503 };
      });
      await run.call("GetLog", getLog(8, { retries: 2, retryInterval: 10 }));
      await run.advanceInSteps(60_000, 1000);
      expect(calls).toBe(3);
      expect(notes(run).map((n) => n.status)).toEqual([
        "Uploading",
        "UploadFailure",
      ]);
    });

    test("a retry that succeeds reports Uploaded once", async () => {
      let calls = 0;
      run = await station(version, async () => {
        calls++;
        return calls < 2
          ? { ok: false, status: 500 }
          : { ok: true, status: 200 };
      });
      await run.call("GetLog", getLog(9, { retries: 1, retryInterval: 5 }));
      await run.advanceInSteps(20_000, 1000);
      expect(notes(run).map((n) => n.status)).toEqual([
        "Uploading",
        "Uploaded",
      ]);
    });

    test("an unreachable destination (the upload throws) is UploadFailure", async () => {
      run = await station(version, async () => {
        throw new Error("ECONNREFUSED");
      });
      await run.call("GetLog", getLog(10));
      await run.advanceInSteps(5_000, 500);
      expect(notes(run).map((n) => n.status)).toEqual([
        "Uploading",
        "UploadFailure",
      ]);
    });

    test("an attempt that never answers times out after 60 s", async () => {
      run = await station(version, () => new Promise(() => undefined));
      await run.call("GetLog", getLog(11));
      await run.advanceInSteps(30_000, 1000);
      expect(notes(run).map((n) => n.status)).toEqual(["Uploading"]);
      await run.advanceInSteps(40_000, 1000);
      expect(notes(run).map((n) => n.status)).toEqual([
        "Uploading",
        "UploadFailure",
      ]);
    });

    test("a SecurityLog request is Rejected: the diagnostics file is not mislabeled", async () => {
      const uploads: Upload[] = [];
      run = await station(version, okUploader(uploads));
      const answer = await run.call(
        "GetLog",
        getLog(12, { logType: "SecurityLog" }),
      );
      expect(reply(answer)).toBe("Rejected");
      await run.advance(1000);
      expect(uploads).toEqual([]);
      expect(notes(run)).toEqual([]);
    });

    test.each([
      "ftp://csms.example/x",
      "http://127.0.0.1:8080/x",
      "http://169.254.169.254/latest",
      "http://[::1]/x",
      "https://user:pw@csms.example/x",
      "not a url",
    ])(
      "destination %s is Rejected and nothing is sent",
      async (remoteLocation) => {
        const uploads: Upload[] = [];
        run = await station(version, okUploader(uploads));
        const answer = await run.call(
          "GetLog",
          getLog(13, { log: { remoteLocation } }),
        );
        expect(reply(answer)).toBe("Rejected");
        await run.advance(1000);
        expect(uploads).toEqual([]);
        expect(notes(run)).toEqual([]);
      },
    );

    test("LogUploadAllowPrivateHosts lets a loopback destination through", async () => {
      const uploads: Upload[] = [];
      run = await station(version, okUploader(uploads), {
        LogUploadAllowPrivateHosts: "true",
      });
      const answer = await run.call(
        "GetLog",
        getLog(14, { log: { remoteLocation: "http://127.0.0.1:9000/up" } }),
      );
      expect(reply(answer)).toBe("Accepted");
      await run.advance(100);
      expect(uploads).toHaveLength(1);
    });

    test("oldestTimestamp / latestTimestamp bound the file", async () => {
      const uploads: Upload[] = [];
      run = await station(version, okUploader(uploads));
      run.cp.logger.enableTypes(LogType.GENERAL);
      run.cp.logger.info("inside the window", LogType.GENERAL);
      await run.call(
        "GetLog",
        getLog(15, {
          log: {
            remoteLocation: "https://csms.example/logs/up",
            latestTimestamp: "2000-01-01T00:00:00Z",
          },
        }),
      );
      await run.advance(100);
      expect(uploads[0]!.text).not.toContain("inside the window");
    });

    test("a replaced upload is cancelled: AcceptedCanceled, and the first never reports Uploaded", async () => {
      let release: (() => void) | undefined;
      let n = 0;
      run = await station(version, () => {
        n++;
        if (n === 1) {
          return new Promise((resolve) => {
            release = () => resolve({ ok: true, status: 200 });
          });
        }
        return Promise.resolve({ ok: true, status: 200 });
      });
      expect(reply(await run.call("GetLog", getLog(20)))).toBe("Accepted");
      await run.advance(100);
      expect(reply(await run.call("GetLog", getLog(21)))).toBe(
        "AcceptedCanceled",
      );
      release?.();
      await run.advance(1000);
      const got = notes(run);
      expect(got.filter((s) => s.status === "Uploaded")).toEqual([
        { status: "Uploaded", requestId: 21 },
      ]);
      expect(
        got.some((s) => s.requestId === 20 && s.status === "Uploaded"),
      ).toBe(false);
      if (version !== "1.6") {
        expect(got).toContainEqual({
          status: "AcceptedCanceled",
          requestId: 20,
        });
      } else {
        expect(got.some((s) => s.status === "AcceptedCanceled")).toBe(false);
      }
    });
  },
);

describe("GetLog without the opt-in is unchanged (#926)", () => {
  test.each(["1.6", "2.0.1"] as const)(
    "RealLogUpload off: simulated train, no upload (%s)",
    async (version) => {
      const uploads: Upload[] = [];
      run = await runBehavior({
        version,
        beforeConnect: (cp) => {
          Object.defineProperty(cp, "logUploader", {
            get: () => okUploader(uploads),
          });
        },
      });
      expect(reply(await run.call("GetLog", getLog(30)))).toBe("Accepted");
      await run.advance(5000);
      expect(notes(run).map((n) => n.status)).toEqual([
        "Uploading",
        "Uploaded",
      ]);
      expect(uploads).toEqual([]);
    },
  );

  test("the CSMS cannot switch RealLogUpload on (ChangeConfiguration is Rejected)", async () => {
    run = await runBehavior({ version: "1.6" });
    const answer = await run.call("ChangeConfiguration", {
      key: "RealLogUpload",
      value: "true",
    });
    expect(reply(answer)).toBe("Rejected");
  });
});
