import { browser } from "$app/environment";
import {
  createActor,
  type ActorOptions,
  type AnyActorLogic,
  type EventFromLogic,
  type SnapshotFrom,
} from "xstate";

export interface MachineHandle<TLogic extends AnyActorLogic> {
  /** Reactive snapshot — read `.context`/`.matches()` inside templates/effects. */
  readonly snapshot: SnapshotFrom<TLogic>;
  send: (event: EventFromLogic<TLogic>) => void;
  /** Stop the actor; call from an effect/onMount cleanup. */
  stop: () => void;
}

/**
 * Bridge an XState machine into Svelte 5 runes.
 *
 * State machines remain the source of truth for any flow more complex than a
 * boolean (see docs/areas/frontend/state-machines.md); this adapter only makes
 * their snapshots reactive so components can render from them.
 *
 * During SSR the actor is never started — the initial snapshot is rendered and
 * the machine comes alive on the client.
 */
export function useMachine<TLogic extends AnyActorLogic>(
  logic: TLogic,
  options?: ActorOptions<TLogic>,
): MachineHandle<TLogic> {
  const actor = createActor(logic, options);
  let snapshot = $state.raw(actor.getSnapshot());

  let subscription: { unsubscribe: () => void } | null = null;
  if (browser) {
    subscription = actor.subscribe((next) => {
      snapshot = next;
    });
    actor.start();
  }

  return {
    get snapshot() {
      return snapshot;
    },
    send: (event) => actor.send(event),
    stop: () => {
      subscription?.unsubscribe();
      actor.stop();
    },
  };
}
