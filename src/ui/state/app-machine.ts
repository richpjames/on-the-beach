import { assign, createMachine } from "xstate";
import type { ListenStatus, MusicItemSort, StackWithCount } from "../../types";

export interface AppContext {
  currentFilter: ListenStatus | "all";
  currentStack: number | null;
  searchQuery: string;
  currentSort: MusicItemSort;
  stacks: StackWithCount[];
  isReady: boolean;
  stackManageOpen: boolean;
}

export type AppEvent =
  | { type: "APP_READY" }
  | { type: "FILTER_SELECTED"; filter: ListenStatus | "all" }
  | { type: "STACK_SELECTED"; stackId: number }
  | { type: "STACK_SELECTED_ALL" }
  | { type: "SEARCH_UPDATED"; query: string }
  | { type: "SORT_UPDATED"; sort: MusicItemSort }
  | { type: "STACKS_LOADED"; stacks: StackWithCount[] }
  | { type: "STACK_MANAGE_TOGGLED" }
  | { type: "STACK_DELETED"; stackId: number };

export const appMachine = createMachine({
  types: {} as { context: AppContext; events: AppEvent },
  context: {
    currentFilter: "to-listen",
    currentStack: null,
    searchQuery: "",
    currentSort: "default",
    stacks: [],
    isReady: false,
    stackManageOpen: false,
  },
  on: {
    APP_READY: {
      actions: assign({ isReady: true }),
    },
    FILTER_SELECTED: {
      actions: assign(({ event }) => ({ currentFilter: event.filter })),
    },
    STACK_SELECTED: {
      actions: assign(({ event }) => ({ currentStack: event.stackId })),
    },
    STACK_SELECTED_ALL: {
      actions: assign({ currentStack: null }),
    },
    SEARCH_UPDATED: {
      actions: assign(({ event }) => ({ searchQuery: event.query })),
    },
    SORT_UPDATED: {
      actions: assign(({ event }) => ({ currentSort: event.sort })),
    },
    STACKS_LOADED: {
      actions: assign(({ event }) => ({ stacks: event.stacks })),
    },
    STACK_MANAGE_TOGGLED: {
      actions: assign(({ context }) => ({ stackManageOpen: !context.stackManageOpen })),
    },
    STACK_DELETED: {
      actions: assign(({ context, event }) => ({
        currentStack: context.currentStack === event.stackId ? null : context.currentStack,
        stacks: context.stacks.filter((stack) => stack.id !== event.stackId),
      })),
    },
  },
});
