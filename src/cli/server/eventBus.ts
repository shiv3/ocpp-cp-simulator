import type { CLIEvent } from "../service";

export interface EventEnvelope {
  readonly cpId: string;
  readonly evt: CLIEvent;
}

export type EventSink = (env: EventEnvelope) => void;

export class EventBus {
  private readonly sinks = new Map<string, Set<EventSink>>();

  publish(cpId: string, evt: CLIEvent): void {
    if (evt.event === "log") return;
    const env: EventEnvelope = { cpId, evt };
    this.deliver(cpId, env);
    this.deliver("*", env);
  }

  subscribe(scope: string, sink: EventSink): () => void {
    let set = this.sinks.get(scope);
    if (!set) {
      set = new Set();
      this.sinks.set(scope, set);
    }
    set.add(sink);
    return () => {
      set?.delete(sink);
      if (set && set.size === 0) {
        this.sinks.delete(scope);
      }
    };
  }

  private deliver(scope: string, env: EventEnvelope): void {
    const set = this.sinks.get(scope);
    if (!set) return;
    for (const sink of set) {
      try {
        sink(env);
      } catch (err) {
        process.stderr.write(`[eventBus] sink error: ${err}\n`);
      }
    }
  }
}
