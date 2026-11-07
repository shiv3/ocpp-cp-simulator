/**
 * The rules for `--behavior`, `--allow-behavior-code` and `--unsafe-remote`.
 * A pure function so the daemon's refusals are unit-testable.
 */
export interface BehaviorFlags {
  readonly serverMode: boolean;
  readonly behaviorFiles: readonly string[];
  readonly allowBehaviorCode: boolean;
  readonly unsafeRemote: boolean;
  readonly useBehaviors?: readonly string[];
  readonly watchBehaviors?: boolean;
}

/** An error message, or null when the combination is allowed. */
export function behaviorFlagProblem(flags: BehaviorFlags): string | null {
  if (flags.allowBehaviorCode && flags.unsafeRemote) {
    return (
      "Error: --allow-behavior-code cannot be combined with --unsafe-remote: " +
      "a daemon that runs code from disk must not also drop its network " +
      "protections. Remove one of them."
    );
  }
  if (
    flags.serverMode &&
    flags.behaviorFiles.length > 0 &&
    !flags.allowBehaviorCode
  ) {
    return (
      "Error: --behavior runs the file's code with this process's full " +
      "authority. A daemon needs --allow-behavior-code to say so."
    );
  }
  if (
    (flags.useBehaviors?.length ?? 0) > 0 &&
    flags.behaviorFiles.length === 0
  ) {
    return (
      "Error: --use-behavior selects among the behaviors loaded with " +
      "--behavior; no --behavior file was given."
    );
  }
  if (flags.watchBehaviors && flags.behaviorFiles.length === 0) {
    return (
      "Error: --watch-behaviors reloads the files given with --behavior; " +
      "no --behavior file was given."
    );
  }
  return null;
}
