import type { EventBus, EventHandler, QuorumEvent, QuorumEventType } from '../core/events.ts';

type Listener = (e: QuorumEvent) => void;

export class InMemoryEventBus implements EventBus {
  private readonly listeners = new Map<QuorumEventType, Set<Listener>>();
  private readonly anyListeners = new Set<Listener>();

  emit(e: QuorumEvent): void {
    const typed = this.listeners.get(e.type);
    if (typed) for (const l of typed) safeInvoke(l, e);
    for (const l of this.anyListeners) safeInvoke(l, e);
  }

  on<K extends QuorumEventType>(type: K, fn: EventHandler<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const listener: Listener = fn as unknown as Listener;
    set.add(listener);
    return () => set!.delete(listener);
  }

  onAny(fn: (e: QuorumEvent) => void): () => void {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }
}

function safeInvoke(l: Listener, e: QuorumEvent): void {
  try {
    l(e);
  } catch (err) {
    console.error('[quorum] event listener threw:', err);
  }
}
