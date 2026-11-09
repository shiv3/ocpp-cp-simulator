import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ErrorReporter,
  ErrorReporterInit,
} from "@ocpp-cp-simulator/contracts/errorReporting";
import { REDACTED_VALUE } from "@ocpp-cp-simulator/contracts/redaction";
import {
  type ErrorReportingProcess,
  initErrorReporting,
  reportFatalError,
  resetErrorReportingForTests,
} from "../errorReporting";
import type { RecordedReports } from "./fixtures/recordingErrorReporter";

afterEach(() => {
  resetErrorReportingForTests();
  delete (globalThis as { __recordedReports?: RecordedReports })
    .__recordedReports;
});

type Listener = (error: unknown) => void;

/** A stand-in for `process`: records listeners, stderr and the exit code. */
function fakeProcess() {
  const listeners = new Map<string, Listener[]>();
  const stderr: string[] = [];
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  const proc: ErrorReportingProcess = {
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    exit: vi.fn((code: number) => resolveExit(code)),
    stderr: { write: (text: string) => stderr.push(text) },
  };
  const emit = (event: string, error: unknown) =>
    (listeners.get(event) ?? []).forEach((listener) => listener(error));
  return { proc, listeners, stderr, exited, emit };
}

/** An adapter module recording what the core asks of it. */
function fakeAdapter(reporter: ErrorReporter | null = recordingReporter()) {
  const createErrorReporter = vi.fn(
    async (_init: ErrorReporterInit) => reporter,
  );
  return { module: { createErrorReporter }, createErrorReporter };
}

/**
 * Move fake time on, then let the promise chains it released run. Sync
 * `advanceTimersByTime`: `bun test` also runs this file (CI), and Bun's `vi`
 * has no `advanceTimersByTimeAsync`.
 */
async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function recordingReporter() {
  return {
    captureException: vi.fn(),
    flush: vi.fn(async (_timeoutMs: number) => true),
  };
}

describe("initErrorReporting: selection", () => {
  it.each([
    ["unset", {}],
    ["blank", { OCPP_SIM_ERROR_REPORTER: "  " }],
  ])(
    "loads nothing and installs nothing when the selector is %s",
    async (_label, env) => {
      const builtin = vi.fn();
      const importModule = vi.fn();
      const { proc, listeners, stderr } = fakeProcess();
      await expect(
        initErrorReporting(env, {
          builtins: { sentry: builtin },
          importModule,
          process: proc,
        }),
      ).resolves.toBe(false);
      expect(builtin).not.toHaveBeenCalled();
      expect(importModule).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
      expect(stderr).toEqual([]);
    },
  );

  it("loads a built-in adapter by name, with the release, env and scrubber", async () => {
    const { module, createErrorReporter } = fakeAdapter();
    const importModule = vi.fn();
    const { proc } = fakeProcess();
    const env = { OCPP_SIM_ERROR_REPORTER: " sentry ", APP_VERSION: "9.9.9" };
    await expect(
      initErrorReporting(env, {
        builtins: { sentry: async () => module },
        importModule,
        process: proc,
      }),
    ).resolves.toBe(true);
    expect(importModule).not.toHaveBeenCalled();

    const init = createErrorReporter.mock.calls[0]![0];
    expect(init.release).toBe("9.9.9");
    expect(init.env).toBe(env);
    expect(
      JSON.stringify(init.scrub({ url: "ws://cp:secret@csms.example/ocpp" })),
    ).not.toContain("secret");
    expect(init.scrub({ message: "Bearer tok-123" }).message).toContain(
      REDACTED_VALUE,
    );
  });

  it("imports a relative module specifier from the working directory", async () => {
    const { proc } = fakeProcess();
    await expect(
      initErrorReporting(
        { OCPP_SIM_ERROR_REPORTER: "./fixtures/recordingErrorReporter.ts" },
        { builtins: {}, cwd: import.meta.dirname, process: proc },
      ),
    ).resolves.toBe(true);

    await reportFatalError(new Error("boom"));
    const record = (globalThis as { __recordedReports?: RecordedReports })
      .__recordedReports;
    expect(record?.inits).toHaveLength(1);
    expect(record?.captured).toEqual([
      {
        error: new Error("boom"),
        context: { mechanism: "fatal", handled: false },
      },
    ]);
  });

  it("imports an absolute module specifier", async () => {
    const { proc } = fakeProcess();
    const specifier = path.join(
      import.meta.dirname,
      "fixtures/recordingErrorReporter.ts",
    );
    await expect(
      initErrorReporting(
        { OCPP_SIM_ERROR_REPORTER: specifier },
        { builtins: {}, cwd: "/nonexistent", process: proc },
      ),
    ).resolves.toBe(true);
  });

  it("imports any other value as a package name", async () => {
    const { module } = fakeAdapter();
    const importModule = vi.fn(async () => module);
    const { proc } = fakeProcess();
    await expect(
      initErrorReporting(
        { OCPP_SIM_ERROR_REPORTER: "@acme/ocpp-sim-reporter" },
        { builtins: {}, importModule, process: proc },
      ),
    ).resolves.toBe(true);
    expect(importModule).toHaveBeenCalledWith("@acme/ocpp-sim-reporter");
  });
});

describe("initErrorReporting: reporting stays off", () => {
  async function initWith(
    load: () => Promise<unknown>,
    name = "@acme/reporter",
  ) {
    const fake = fakeProcess();
    const on = await initErrorReporting(
      { OCPP_SIM_ERROR_REPORTER: name },
      { builtins: { sentry: load }, importModule: load, process: fake.proc },
    );
    return { on, ...fake };
  }

  it("when the module cannot be loaded", async () => {
    const { on, stderr, listeners } = await initWith(() =>
      Promise.reject(new Error("Cannot find package '@acme/reporter'")),
    );
    expect(on).toBe(false);
    expect(stderr).toEqual([
      "Error reporting disabled: cannot load @acme/reporter (Cannot find package '@acme/reporter')\n",
    ]);
    expect(listeners.size).toBe(0);
  });

  it("when a relative module does not exist", async () => {
    const { proc, stderr } = fakeProcess();
    await expect(
      initErrorReporting(
        { OCPP_SIM_ERROR_REPORTER: "./fixtures/missing.ts" },
        { builtins: {}, cwd: import.meta.dirname, process: proc },
      ),
    ).resolves.toBe(false);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^Error reporting disabled: cannot load /);
  });

  it("when the module does not export createErrorReporter", async () => {
    const { on, stderr } = await initWith(async () => ({ default: {} }));
    expect(on).toBe(false);
    expect(stderr).toEqual([
      "Error reporting disabled: @acme/reporter does not export createErrorReporter\n",
    ]);
  });

  it("when the factory rejects", async () => {
    const { on, stderr, listeners } = await initWith(async () => ({
      createErrorReporter: () => Promise.reject(new Error("bad options")),
    }));
    expect(on).toBe(false);
    expect(stderr).toEqual([
      "Error reporting disabled: @acme/reporter did not start (bad options)\n",
    ]);
    expect(listeners.size).toBe(0);

    // Off means off: a later fatal exit reaches no adapter.
    await expect(reportFatalError(new Error("x"))).resolves.toBeUndefined();
  });

  it("when the factory resolves null (selected but not configured)", async () => {
    const { module } = fakeAdapter(null);
    const sentry = await initWith(async () => module, "sentry");
    expect(sentry.on).toBe(false);
    expect(sentry.stderr).toEqual([
      "Error reporting disabled: sentry selected but SENTRY_DSN is not set\n",
    ]);
    expect(sentry.listeners.size).toBe(0);

    const other = await initWith(async () => module);
    expect(other.stderr).toEqual([
      "Error reporting disabled: @acme/reporter selected but not configured\n",
    ]);
  });
});

describe("initErrorReporting: start-up bound", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Start init with a factory whose promise the test settles. */
  function startWith(factoryResult: Promise<ErrorReporter | null>) {
    const fake = fakeProcess();
    const state: { on?: boolean } = {};
    void initErrorReporting(
      { OCPP_SIM_ERROR_REPORTER: "sentry" },
      {
        builtins: {
          sentry: async () => ({ createErrorReporter: () => factoryResult }),
        },
        process: fake.proc,
      },
    ).then((on) => (state.on = on));
    return { state, ...fake };
  }

  const timedOut =
    "Error reporting disabled: sentry did not start within 2000 ms\n";

  it("gives up after 2 s on an adapter that never starts", async () => {
    vi.useFakeTimers();
    const { state, stderr, listeners } = startWith(new Promise(() => {}));

    await advance(1999);
    expect(state.on).toBeUndefined();
    await advance(1);
    expect(state.on).toBe(false);
    expect(stderr).toEqual([timedOut]);
    expect(listeners.size).toBe(0);
  });

  it("drops an adapter that starts after the bound", async () => {
    vi.useFakeTimers();
    let resolveFactory: (reporter: ErrorReporter) => void = () => {};
    const reporter = recordingReporter();
    const { state, stderr, listeners } = startWith(
      new Promise((resolve) => (resolveFactory = resolve)),
    );

    await advance(2000);
    resolveFactory(reporter);
    await advance(0);

    expect(state.on).toBe(false);
    expect(listeners.size).toBe(0);
    await reportFatalError(new Error("late"));
    expect(reporter.captureException).not.toHaveBeenCalled();
    expect(reporter.flush).not.toHaveBeenCalled();
    expect(stderr).toEqual([timedOut]);
  });

  it("writes nothing more when the adapter fails after the bound", async () => {
    vi.useFakeTimers();
    let rejectFactory: (err: Error) => void = () => {};
    const { state, stderr } = startWith(
      new Promise((_resolve, reject) => (rejectFactory = reject)),
    );

    await advance(2000);
    rejectFactory(new Error("late failure"));
    await advance(0);

    expect(state.on).toBe(false);
    expect(stderr).toEqual([timedOut]);
  });

  it("leaves no timer behind when the adapter starts in time", async () => {
    vi.useFakeTimers();
    const { state, listeners } = startWith(
      Promise.resolve(recordingReporter()),
    );

    await advance(0);

    expect(state.on).toBe(true);
    expect(listeners.size).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no timer when nothing is selected", async () => {
    vi.useFakeTimers();
    await expect(initErrorReporting({}, {})).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("reportFatalError", () => {
  it("does nothing while reporting is off", async () => {
    await expect(reportFatalError(new Error("x"))).resolves.toBeUndefined();
  });

  it("captures the error and flushes before the caller exits", async () => {
    const reporter = recordingReporter();
    const { module } = fakeAdapter(reporter);
    await initErrorReporting(
      { OCPP_SIM_ERROR_REPORTER: "sentry" },
      { builtins: { sentry: async () => module }, process: fakeProcess().proc },
    );
    const err = new Error("fatal");

    await reportFatalError(err);

    expect(reporter.captureException).toHaveBeenCalledWith(err, {
      mechanism: "fatal",
      handled: false,
    });
    expect(reporter.flush).toHaveBeenCalledWith(2000);
    expect(reporter.flush.mock.invocationCallOrder[0]!).toBeGreaterThan(
      reporter.captureException.mock.invocationCallOrder[0]!,
    );
  });

  it("still resolves when the adapter throws or its flush rejects", async () => {
    const reporter = recordingReporter();
    reporter.captureException.mockImplementation(() => {
      throw new Error("adapter bug");
    });
    reporter.flush.mockRejectedValue(new Error("network"));
    const { module } = fakeAdapter(reporter);
    await initErrorReporting(
      { OCPP_SIM_ERROR_REPORTER: "sentry" },
      { builtins: { sentry: async () => module }, process: fakeProcess().proc },
    );
    await expect(reportFatalError(new Error("x"))).resolves.toBeUndefined();
  });

  it("resolves after 2 s even when the adapter's flush never settles", async () => {
    vi.useFakeTimers();
    try {
      const reporter = recordingReporter();
      reporter.flush.mockReturnValue(new Promise<boolean>(() => {}));
      const { module } = fakeAdapter(reporter);
      await initErrorReporting(
        { OCPP_SIM_ERROR_REPORTER: "sentry" },
        {
          builtins: { sentry: async () => module },
          process: fakeProcess().proc,
        },
      );
      let settled = false;
      void reportFatalError(new Error("x")).then(() => (settled = true));

      await advance(1999);
      expect(settled).toBe(false);
      await advance(1);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("process handlers", () => {
  async function activate() {
    const reporter = recordingReporter();
    const { module } = fakeAdapter(reporter);
    const fake = fakeProcess();
    await initErrorReporting(
      { OCPP_SIM_ERROR_REPORTER: "sentry" },
      { builtins: { sentry: async () => module }, process: fake.proc },
    );
    return { reporter, ...fake };
  }

  it("are installed only while a reporter is active", async () => {
    const { listeners } = await activate();
    expect([...listeners.keys()].sort()).toEqual([
      "uncaughtException",
      "unhandledRejection",
    ]);
    expect(listeners.get("unhandledRejection")).toHaveLength(1);
  });

  it.each(["unhandledRejection", "uncaughtException"])(
    "%s: captures, flushes, prints to stderr and exits 1",
    async (event) => {
      const { reporter, emit, exited, stderr, proc } = await activate();
      const err = new Error(`${event} boom`);

      emit(event, err);

      await expect(exited).resolves.toBe(1);
      expect(reporter.captureException).toHaveBeenCalledWith(err, {
        mechanism: event,
        handled: false,
      });
      expect(reporter.flush).toHaveBeenCalledWith(2000);
      expect(proc.exit).toHaveBeenCalledTimes(1);
      expect(
        (proc.exit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
      ).toBeGreaterThan(reporter.flush.mock.invocationCallOrder[0]!);
      expect(stderr.join("")).toContain(`${event} boom`);
    },
  );

  it("exit 1 even when the flush rejects, and report a second failure only once", async () => {
    const { reporter, emit, exited, stderr, proc } = await activate();
    reporter.flush.mockRejectedValue(new Error("network"));

    emit("unhandledRejection", "first");
    emit("uncaughtException", new Error("second"));

    await expect(exited).resolves.toBe(1);
    expect(reporter.captureException).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledTimes(1);
    expect(stderr.join("")).toContain("second");
  });

  it("still reports and exits 1 when inspecting the error throws", async () => {
    const { reporter, emit, exited, stderr } = await activate();
    const throwingInspect = (): never => {
      throw new Error("inspect hook bug");
    };
    const first = {
      [Symbol.for("nodejs.util.inspect.custom")]: throwingInspect,
    };
    const second = {
      [Symbol.for("nodejs.util.inspect.custom")]: throwingInspect,
    };

    emit("unhandledRejection", first);
    emit("uncaughtException", second);

    await expect(exited).resolves.toBe(1);
    expect(reporter.captureException).toHaveBeenCalledWith(first, {
      mechanism: "unhandledRejection",
      handled: false,
    });
    expect(reporter.flush).toHaveBeenCalledWith(2000);
    expect(stderr).toEqual([
      "[error that cannot be inspected]\n",
      "[error that cannot be inspected]\n",
    ]);
  });

  it("exit 1 after 2 s even when the adapter's flush never settles", async () => {
    vi.useFakeTimers();
    try {
      const { reporter, emit, proc } = await activate();
      reporter.flush.mockReturnValue(new Promise<boolean>(() => {}));

      emit("uncaughtException", new Error("boom"));

      await advance(1999);
      expect(proc.exit).not.toHaveBeenCalled();
      await advance(1);
      expect(proc.exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
