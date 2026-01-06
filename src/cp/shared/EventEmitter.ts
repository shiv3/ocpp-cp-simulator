/**
 * Type-safe EventEmitter for ChargePoint events
 * Based on EventEmitter2 with additional type safety
 */

import EventEmitter2 from "eventemitter2";

export type EventListener<T = unknown> = (data: T) => void;

export interface EventMap {
  [event: string]: unknown;
}

/**
 * Type-safe wrapper around EventEmitter2
 * Provides the same API as before but with EventEmitter2's additional features:
 * - Wildcard support: emitter.on('event.*', listener)
 * - onAny: Listen to all events
 * - Better performance with many listeners
 */
export class EventEmitter<T extends EventMap> {
  private emitter: EventEmitter2;

  constructor() {
    this.emitter = new EventEmitter2({
      wildcard: true,
      delimiter: ".",
      maxListeners: 50,
      // Prevent memory leaks by warning
      verboseMemoryLeak: true,
    });
  }

  /**
   * Subscribe to an event
   * Supports wildcards: on('connector.*', listener)
   * @returns Unsubscribe function
   */
  on<K extends keyof T>(event: K, listener: EventListener<T[K]>): () => void;
  on(event: string, listener: EventListener<unknown>): () => void;
  on(event: string | keyof T, listener: EventListener<unknown>): () => void {
    this.emitter.on(event as string, listener);

    // Return unsubscribe function
    return () => {
      this.emitter.off(event as string, listener);
    };
  }

  /**
   * Subscribe to an event (one-time only)
   * Supports wildcards: once('connector.*', listener)
   */
  once<K extends keyof T>(event: K, listener: EventListener<T[K]>): () => void;
  once(event: string, listener: EventListener<unknown>): () => void;
  once(event: string | keyof T, listener: EventListener<unknown>): () => void {
    this.emitter.once(event as string, listener);

    // Return unsubscribe function
    return () => {
      this.emitter.off(event as string, listener);
    };
  }

  /**
   * Emit an event to all listeners
   */
  emit<K extends keyof T>(event: K, data: T[K]): void {
    try {
      this.emitter.emit(event as string, data);
    } catch (error) {
      console.error(`Error in event listener for "${String(event)}":`, error);
    }
  }

  /**
   * Remove a specific listener
   */
  off<K extends keyof T>(event: K, listener: EventListener<T[K]>): void;
  off(event: string, listener: EventListener<unknown>): void;
  off(event: string | keyof T, listener: EventListener<unknown>): void {
    this.emitter.off(event as string, listener);
  }

  /**
   * Remove all listeners for a specific event
   */
  removeAllListeners<K extends keyof T>(event?: K): void {
    if (event) {
      this.emitter.removeAllListeners(event as string);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  /**
   * Get the number of listeners for an event
   */
  listenerCount<K extends keyof T>(event: K): number {
    return this.emitter.listenerCount(event as string);
  }

  /**
   * Check if there are any listeners for an event
   */
  hasListeners<K extends keyof T>(event: K): boolean {
    return this.listenerCount(event) > 0;
  }

  /**
   * Listen to all events (EventEmitter2 feature)
   * @param listener Callback that receives (event, data)
   * @returns Unsubscribe function
   */
  onAny(
    listener: (event: string | string[], data: unknown) => void,
  ): () => void {
    this.emitter.onAny(listener);
    return () => {
      this.emitter.offAny(listener);
    };
  }

  /**
   * Remove a listener from all events
   */
  offAny(listener: (event: string | string[], data: unknown) => void): void {
    this.emitter.offAny(listener);
  }

  /**
   * Wait for an event (Promise-based)
   * @param event Event name (supports wildcards)
   * @param timeout Optional timeout in milliseconds
   * @returns Promise that resolves with the event data
   */
  async waitFor<K extends keyof T>(event: K, timeout?: number): Promise<T[K]>;
  async waitFor(event: string, timeout?: number): Promise<unknown>;
  async waitFor(event: string | keyof T, timeout?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => {
            this.emitter.off(event as string, handler);
            reject(new Error(`Timeout waiting for event: ${String(event)}`));
          }, timeout)
        : null;

      const handler = (data: unknown) => {
        if (timer) clearTimeout(timer);
        resolve(data);
      };

      this.emitter.once(event as string, handler);
    });
  }
}
