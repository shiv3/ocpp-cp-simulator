import { toast, type ExternalToast } from "sonner";

/**
 * Web-console toast API (#937). The only module that imports `sonner` for
 * posting; call sites use `notify.*`. The visual host is `<AppToaster />`
 * (components/ui/sonner.tsx), mounted once in `App.tsx`.
 *
 * Use a toast for the transient result of a user action. Keep per-field
 * validation and persistent contextual errors inline, and never toast OCPP
 * frames, status changes or log entries (those belong in the logs/timeline).
 */

export type NotifyKind = "success" | "error" | "warning" | "info";

export interface NotifyOptions {
  /** Stable key. Posting again with the same id updates that toast in place
   *  instead of stacking another. Defaults to `<kind>:<message>`. */
  id?: string | number;
  /** Secondary line under the message. */
  description?: string;
  /** Override the default auto-dismiss time (ms; `Infinity` = until closed). */
  duration?: number;
}

/** Auto-dismiss times. Errors stay longest: they usually need to be read and
 *  acted on, and a success must not hide them (they have separate ids). */
export const TOAST_DURATION_MS: Record<NotifyKind, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 10000,
};

/** Id used for dedupe when the caller gives none: identical repeats of the
 *  same kind+message collapse into one toast, different messages (or kinds)
 *  never replace each other. */
export function toastId(kind: NotifyKind, message: string): string {
  return `${kind}:${message}`;
}

function post(kind: NotifyKind, message: string, opts: NotifyOptions = {}) {
  const external: ExternalToast = {
    id: opts.id ?? toastId(kind, message),
    description: opts.description,
    duration: opts.duration ?? TOAST_DURATION_MS[kind],
  };
  return toast[kind](message, external);
}

export interface NotifyPromiseMessages<T> {
  /** Shown while the promise is pending. */
  loading: string;
  success: string | ((value: T) => string);
  error: string | ((reason: unknown) => string);
  /** Shared id for the pending → result transition (and dedupe). Defaults to
   *  one unique id per call so concurrent operations never overwrite each
   *  other. */
  id?: string | number;
}

let promiseSeq = 0;

export const notify = {
  success: (message: string, opts?: NotifyOptions) =>
    post("success", message, opts),
  error: (message: string, opts?: NotifyOptions) =>
    post("error", message, opts),
  warning: (message: string, opts?: NotifyOptions) =>
    post("warning", message, opts),
  info: (message: string, opts?: NotifyOptions) => post("info", message, opts),

  /**
   * Pending → success/error transition for one async action. Returns the
   * original promise unchanged (a rejection is still the caller's to handle,
   * e.g. to `console.error`). Without an explicit `id` each call gets its own
   * toast, so two overlapping operations never overwrite one another.
   */
  promise<T>(promise: Promise<T>, msgs: NotifyPromiseMessages<T>): Promise<T> {
    const id = msgs.id ?? `promise:${++promiseSeq}`;
    toast.promise(promise, {
      id,
      loading: msgs.loading,
      success: (value: T) => ({
        message:
          typeof msgs.success === "function"
            ? msgs.success(value)
            : msgs.success,
        duration: TOAST_DURATION_MS.success,
      }),
      error: (reason: unknown) => ({
        message:
          typeof msgs.error === "function" ? msgs.error(reason) : msgs.error,
        duration: TOAST_DURATION_MS.error,
      }),
    });
    return promise;
  },

  dismiss: (id?: string | number) => toast.dismiss(id),
};
