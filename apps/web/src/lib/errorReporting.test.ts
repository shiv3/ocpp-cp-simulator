import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ErrorReporter,
  ErrorReporterInit,
} from "@ocpp-cp-simulator/contracts/errorReporting";
import { REDACTED_VALUE } from "@ocpp-cp-simulator/contracts/redaction";
import {
  ERROR_REPORTER_BUFFER_SIZE,
  ERROR_REPORTER_WAIT_MS,
  initErrorReporting,
  type RootErrorHooks,
  rootErrorHooks,
} from "./errorReporting";

afterEach(() => {
  vi.restoreAllMocks();
});

function recordingReporter() {
  return {
    captureException: vi.fn(),
    flush: vi.fn(async () => true),
  };
}

function builtinsWith(reporter: ErrorReporter | null) {
  const createErrorReporter = vi.fn(
    async (_init: ErrorReporterInit) => reporter,
  );
  const load = vi.fn(async () => ({ createErrorReporter }));
  return { builtins: { sentry: load }, load, createErrorReporter };
}

describe("initErrorReporting", () => {
  it.each([
    ["unset", {}],
    ["blank", { VITE_ERROR_REPORTER: " " }],
  ])(
    "loads no adapter when the build's selector is %s",
    async (_label, env) => {
      const { builtins, load } = builtinsWith(recordingReporter());
      await expect(initErrorReporting(env, builtins)).resolves.toEqual({});
      expect(load).not.toHaveBeenCalled();
    },
  );

  it("loads a built-in adapter with the release, env and scrubber", async () => {
    const { builtins, createErrorReporter } = builtinsWith(recordingReporter());
    const env = { VITE_ERROR_REPORTER: "sentry", VITE_SENTRY_DSN: "x" };
    const hooks = await initErrorReporting(env, builtins);
    expect(Object.keys(hooks).sort()).toEqual([
      "onCaughtError",
      "onRecoverableError",
      "onUncaughtError",
    ]);

    const init = createErrorReporter.mock.calls[0]![0];
    expect(init.env).toBe(env);
    // The release is the console's own build version, never empty.
    expect(init.release).toBeTruthy();
    expect(
      JSON.stringify(init.scrub({ message: "ws://cp:secret@csms.example" })),
    ).not.toContain("secret");
    expect(init.scrub({ message: 'password="hunter2"' }).message).toContain(
      REDACTED_VALUE,
    );
  });

  it("stays off with one warning for an unknown name", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { builtins, load } = builtinsWith(recordingReporter());
    await expect(
      initErrorReporting({ VITE_ERROR_REPORTER: "datadog" }, builtins),
    ).resolves.toEqual({});
    expect(load).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0]![0])).toContain('"datadog"');
  });

  it("stays off with one warning when the adapter is not configured", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { builtins } = builtinsWith(null);
    await expect(
      initErrorReporting({ VITE_ERROR_REPORTER: "sentry" }, builtins),
    ).resolves.toEqual({});
    expect(warned).toHaveBeenCalledWith(
      "Error reporting disabled: sentry selected but VITE_SENTRY_DSN is not set",
    );
  });

  it.each([
    [
      "the adapter chunk fails to load",
      () => Promise.reject(new Error("chunk")),
    ],
    [
      "the adapter fails to start",
      async () => ({
        createErrorReporter: () => Promise.reject(new Error("bad options")),
      }),
    ],
  ])("renders without reporting when %s", async (_label, load) => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      initErrorReporting({ VITE_ERROR_REPORTER: "sentry" }, { sentry: load }),
    ).resolves.toEqual({});
    expect(warned).toHaveBeenCalledTimes(1);
  });
});

describe("rootErrorHooks", () => {
  it("hands every React root error to the reporter and still logs it", () => {
    const reporter = recordingReporter();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const hooks = rootErrorHooks(reporter);

    const info = { componentStack: "\n    at Broken" };
    const errors = [new Error("uncaught"), new Error("caught"), new Error("r")];
    hooks.onUncaughtError?.(errors[0], info);
    hooks.onCaughtError?.(errors[1], info);
    hooks.onRecoverableError?.(errors[2], info);

    expect(reporter.captureException.mock.calls).toEqual([
      [errors[0], { mechanism: "react.uncaught", handled: false, ...info }],
      [errors[1], { mechanism: "react.caught", handled: true, ...info }],
      [errors[2], { mechanism: "react.recoverable", handled: true, ...info }],
    ]);
    expect(logged).toHaveBeenCalledTimes(3);
    expect(logged).toHaveBeenCalledWith(errors[1], info.componentStack);
  });

  it("omits a missing component stack and survives a throwing reporter", () => {
    const reporter = recordingReporter();
    reporter.captureException.mockImplementation(() => {
      throw new Error("adapter bug");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const hooks = rootErrorHooks(reporter);
    const err = new Error("r");

    expect(() => hooks.onRecoverableError?.(err, {})).not.toThrow();
    expect(reporter.captureException).toHaveBeenCalledWith(err, {
      mechanism: "react.recoverable",
      handled: true,
    });
    expect(logged).toHaveBeenCalledWith(err);
  });
});

describe("initErrorReporting bounded wait", () => {
  const env = { VITE_ERROR_REPORTER: "sentry" };

  afterEach(() => {
    vi.useRealTimers();
  });

  /** An adapter whose chunk resolves only when the test says so. */
  function lateBuiltins() {
    let settle!: (module: {
      createErrorReporter: () => Promise<ErrorReporter | null>;
    }) => void;
    let fail!: (err: unknown) => void;
    const chunk = new Promise<{
      createErrorReporter: () => Promise<ErrorReporter | null>;
    }>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    return {
      builtins: { sentry: () => chunk },
      loaded: (reporter: ErrorReporter | null) =>
        settle({ createErrorReporter: async () => reporter }),
      failed: (err: unknown) => fail(err),
    };
  }

  /** Starts the init under fake timers and lets the bound elapse. */
  async function startPastTheBound(
    builtins: ReturnType<typeof lateBuiltins>["builtins"],
  ) {
    vi.useFakeTimers();
    let hooks: RootErrorHooks | undefined;
    void initErrorReporting(env, builtins).then((h) => {
      hooks = h;
    });
    await vi.advanceTimersByTimeAsync(ERROR_REPORTER_WAIT_MS);
    return hooks;
  }

  it("does not resolve before the bound while the adapter is loading", async () => {
    vi.useFakeTimers();
    let settled = false;
    void initErrorReporting(env, lateBuiltins().builtins).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(ERROR_REPORTER_WAIT_MS - 1);
    expect(settled).toBe(false);
  });

  it("resolves to the root hooks once the bound elapses, even if the adapter never loads", async () => {
    const hooks = await startPastTheBound(lateBuiltins().builtins);
    expect(Object.keys(hooks ?? {}).sort()).toEqual([
      "onCaughtError",
      "onRecoverableError",
      "onUncaughtError",
    ]);
  });

  it("logs at once and forwards errors raised before a late adapter loads", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const late = lateBuiltins();
    const hooks = await startPastTheBound(late.builtins);
    const info = { componentStack: "\n    at Broken" };
    const early = new Error("early");
    hooks!.onCaughtError?.(early, info);
    expect(logged).toHaveBeenCalledTimes(1);

    const reporter = recordingReporter();
    late.loaded(reporter);
    await vi.runAllTimersAsync();
    expect(reporter.captureException.mock.calls).toEqual([
      [early, { mechanism: "react.caught", handled: true, ...info }],
    ]);

    const after = new Error("after");
    hooks!.onRecoverableError?.(after, {});
    expect(reporter.captureException).toHaveBeenLastCalledWith(after, {
      mechanism: "react.recoverable",
      handled: true,
    });
    // Each error is logged once, when it is raised, never again on replay.
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it("survives a reporter that throws on the replayed errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const late = lateBuiltins();
    const hooks = await startPastTheBound(late.builtins);
    hooks!.onRecoverableError?.(new Error("a"), {});
    hooks!.onRecoverableError?.(new Error("b"), {});

    const reporter = recordingReporter();
    reporter.captureException.mockImplementation(() => {
      throw new Error("adapter bug");
    });
    late.loaded(reporter);
    await vi.runAllTimersAsync();
    expect(reporter.captureException).toHaveBeenCalledTimes(2);
  });

  it("caps the errors kept while the adapter is loading", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const late = lateBuiltins();
    const hooks = await startPastTheBound(late.builtins);
    for (let i = 0; i < ERROR_REPORTER_BUFFER_SIZE + 5; i++) {
      hooks!.onRecoverableError?.(new Error(String(i)), {});
    }

    const reporter = recordingReporter();
    late.loaded(reporter);
    await vi.runAllTimersAsync();
    expect(reporter.captureException).toHaveBeenCalledTimes(
      ERROR_REPORTER_BUFFER_SIZE,
    );
    // The first errors are the ones kept: they usually explain the rest.
    expect(reporter.captureException.mock.calls[0]![0]).toEqual(new Error("0"));
  });

  it.each([
    [
      "is not configured",
      (late: ReturnType<typeof lateBuiltins>) => late.loaded(null),
    ],
    [
      "fails to load",
      (late: ReturnType<typeof lateBuiltins>) =>
        late.failed(new Error("chunk")),
    ],
  ])(
    "only logs, with one warning, when a late adapter %s",
    async (_label, finish) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const late = lateBuiltins();
      const hooks = await startPastTheBound(late.builtins);
      const early = new Error("early");
      hooks!.onUncaughtError?.(early, { componentStack: "" });

      finish(late);
      await vi.runAllTimersAsync();
      expect(warned).toHaveBeenCalledTimes(1);

      hooks!.onUncaughtError?.(new Error("after"), { componentStack: "" });
      expect(logged).toHaveBeenCalledTimes(2);
      expect(logged).toHaveBeenNthCalledWith(1, early);
    },
  );
});
