/**
 * Event fan-out.
 *
 * The engine takes exactly one sink, so this is what turns it into any number of
 * subscribers. Three properties matter and each one is here because the failure it
 * prevents is invisible from a consumer's side.
 *
 * **A listener cannot stall the loop.** `EventSink` is synchronous and returns
 * nothing on purpose — the protocol makes `event` a notification for the same
 * reason. So publish never awaits, and a subscriber that needs to do I/O queues
 * internally.
 *
 * **A listener cannot break the loop.** A throwing listener is caught. It cannot be
 * logged, because this package renders nothing, so it is handed to
 * `onListenerError` when one was supplied and dropped otherwise. Letting it
 * propagate would make one broken UI component abort a turn.
 *
 * **Unsubscribing during a publish is safe.** The listener set is copied before
 * iteration, so a listener that unsubscribes itself — the normal shape of "wait for
 * `turn.completed`" — does not perturb the iteration.
 */

import type { AdzeEvent } from '@adze/protocol';
import type { EventListener, Unsubscribe } from '../types.js';

interface Subscription {
  readonly listener: EventListener;
  /** Undefined subscribes to every session. */
  readonly sessionId: string | undefined;
}

export class EventBus {
  private readonly subscriptions = new Set<Subscription>();

  constructor(private readonly onListenerError?: (error: unknown, event: AdzeEvent) => void) {}

  subscribe(listener: EventListener, sessionId?: string): Unsubscribe {
    const subscription: Subscription = { listener, sessionId };
    this.subscriptions.add(subscription);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.subscriptions.delete(subscription);
    };
  }

  readonly publish = (event: AdzeEvent): void => {
    for (const subscription of [...this.subscriptions]) {
      if (!matches(subscription.sessionId, event.sessionId)) continue;
      try {
        subscription.listener(event);
      } catch (error) {
        this.onListenerError?.(error, event);
      }
    }
  };

  clear(): void {
    this.subscriptions.clear();
  }

  /** For tests: proves `dispose` actually drops listeners rather than muting them. */
  get size(): number {
    return this.subscriptions.size;
  }
}

/**
 * Whether a session-scoped subscription should see an event.
 *
 * The prefix case is subagent delegation: core mints a subagent's session id as
 * `` `${parentId}~${suffix}` ``, and a surface rendering a session wants the work
 * done on its behalf. Matching on that shape means this package depends on a core
 * id-construction convention that nothing in `@adze/protocol` describes — noted
 * here rather than left as a coincidence that keeps working.
 */
function matches(scope: string | undefined, sessionId: string): boolean {
  if (scope === undefined) return true;
  return sessionId === scope || sessionId.startsWith(`${scope}~`);
}
