import type { SessionSettledInfo } from "../../service";
import type {
  RegistryMembershipEvent,
  RegistryMembershipSink,
  SessionSettledSink,
} from "../CPRegistry";

export function notifySessionSettled(
  sinks: ReadonlySet<SessionSettledSink>,
  cpId: string,
  info: SessionSettledInfo,
): void {
  for (const sink of sinks) {
    try {
      sink(cpId, info);
    } catch (err) {
      console.error(
        `[CPRegistry] session-settled sink error for "${cpId}":`,
        err,
      );
    }
  }
}

export function notifyInitChange(sinks: ReadonlySet<() => void>): void {
  for (const sink of sinks) {
    try {
      sink();
    } catch {
      process.stderr.write("[CPRegistry] init change sink error\n");
    }
  }
}

export function notifyRegistryMembership(
  sinks: ReadonlySet<RegistryMembershipSink>,
  event: RegistryMembershipEvent,
): void {
  for (const sink of sinks) {
    try {
      sink(event);
    } catch {
      process.stderr.write("[CPRegistry] registry membership sink error\n");
    }
  }
}
