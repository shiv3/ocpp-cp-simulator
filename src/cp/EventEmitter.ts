/**
 * Type-safe EventEmitter for ChargePoint events
 */

export type EventListener<T = unknown> = (data: T) => void;

export interface EventMap {
  [event: string]: unknown;
}

export class EventEmitter<T extends EventMap> {
  private listeners: Map<keyof T, Set<EventListener<T[keyof T]>>> = new Map();

  /**
   * Subscribe to an event
   * @returns Unsubscribe function
   */
  on<K extends keyof T>(event: K, listener: EventListener<T[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    const eventListeners = this.listeners.get(event)!;
    eventListeners.add(listener as EventListener<T[keyof T]>);

    // Return unsubscribe function
    return () => {
      eventListeners.delete(listener as EventListener<T[keyof T]>);
      if (eventListeners.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  /**
   * Subscribe to an event (one-time only)
   */
  once<K extends keyof T>(event: K, listener: EventListener<T[K]>): () => void {
    const wrappedListener: EventListener<T[K]> = (data) => {
      listener(data);
      unsubscribe();
    };

    const unsubscribe = this.on(event, wrappedListener);
    return unsubscribe;
  }

  /**
   * Emit an event to all listeners
   */
  emit<K extends keyof T>(event: K, data: T[K]): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach((listener) => {
        try {
          listener(data);
        } catch (error) {
          console.error(`Error in event listener for "${String(event)}":`, error);
        }
      });
    }
  }

  /**
   * Remove a specific listener
   */
  off<K extends keyof T>(event: K, listener: EventListener<T[K]>): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener as EventListener<T[keyof T]>);
      if (eventListeners.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * Remove all listeners for a specific event
   */
  removeAllListeners<K extends keyof T>(event?: K): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Get the number of listeners for an event
   */
  listenerCount<K extends keyof T>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /**
   * Check if there are any listeners for an event
   */
  hasListeners<K extends keyof T>(event: K): boolean {
    return this.listenerCount(event) > 0;
  }
}
