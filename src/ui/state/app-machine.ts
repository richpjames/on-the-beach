import { assign, createMachine } from "xstate";
import type {
  ListenStatus,
  MusicItemSort,
  MusicItemSortDirection,
  StackWithCount,
} from "../../types";

export interface AppContext {
  currentFilter: ListenStatus | "all" | "scheduled";
  currentStack: number | null;
  searchQuery: string;
  currentSort: MusicItemSort;
  currentSortDirection: MusicItemSortDirection;
  stacks: StackWithCount[];
  isReady: boolean;
  stackManageOpen: boolean;
  searchPanelOpen: boolean;
  sortPanelOpen: boolean;
  listVersion: number;
  stackBarVersion: number;
}

export type AppEvent =
  | { type: "APP_READY" }
  | { type: "FILTER_SELECTED"; filter: ListenStatus | "all" | "scheduled" }
  | { type: "STACK_SELECTED"; stackId: number }
  | { type: "STACK_SELECTED_ALL" }
  | { type: "SEARCH_UPDATED"; query: string }
  | { type: "SORT_UPDATED"; sort: MusicItemSort }
  | { type: "SORT_DIRECTION_UPDATED"; direction: MusicItemSortDirection }
  | { type: "STACKS_LOADED"; stacks: StackWithCount[] }
  | { type: "STACK_MANAGE_TOGGLED" }
  | { type: "STACK_DELETED"; stackId: number }
  | { type: "SEARCH_PANEL_TOGGLED" }
  | { type: "SORT_PANEL_TOGGLED" }
  | { type: "BROWSE_PANELS_CLOSED" }
  | { type: "ITEM_CREATED" }
  | { type: "LIST_REFRESH" }
  | { type: "REMINDERS_READY"; itemIds: number[] };

export const appMachine = createMachine({
  types: {} as { context: AppContext; events: AppEvent },
  context: {
    currentFilter: "to-listen",
    currentStack: null,
    searchQuery: "",
    currentSort: "date-added",
    currentSortDirection: "desc",
    stacks: [],
    isReady: false,
    stackManageOpen: false,
    searchPanelOpen: false,
    sortPanelOpen: false,
    listVersion: 0,
    stackBarVersion: 0,
  },
  on: {
    APP_READY: {
      actions: assign({ isReady: true }),
    },
    FILTER_SELECTED: {
      actions: assign(({ context, event }) => ({
        currentFilter: event.filter,
        listVersion: context.listVersion + 1,
      })),
    },
    STACK_SELECTED: {
      actions: assign(({ context, event }) => ({
        currentStack: event.stackId,
        currentFilter: "all",
        listVersion: context.listVersion + 1,
        stackBarVersion: context.stackBarVersion + 1,
      })),
    },
    STACK_SELECTED_ALL: {
      actions: assign(({ context }) => ({
        currentStack: null,
        listVersion: context.listVersion + 1,
        stackBarVersion: context.stackBarVersion + 1,
      })),
    },
    SEARCH_UPDATED: {
      actions: assign(({ context, event }) => ({
        searchQuery: event.query,
        listVersion: context.listVersion + 1,
        stackBarVersion: context.stackBarVersion + 1,
      })),
    },
    SORT_UPDATED: {
      actions: assign(({ context, event }) => ({
        currentSort: event.sort,
        listVersion: context.listVersion + 1,
      })),
    },
    SORT_DIRECTION_UPDATED: {
      actions: assign(({ context, event }) => ({
        currentSortDirection: event.direction,
        listVersion: context.listVersion + 1,
      })),
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
        listVersion: context.listVersion + 1,
        stackBarVersion: context.stackBarVersion + 1,
      })),
    },
    ITEM_CREATED: {
      actions: assign(({ context }) => ({
        listVersion:
          context.currentFilter === "all" || context.currentFilter === "to-listen"
            ? context.listVersion + 1
            : context.listVersion,
        stackBarVersion: context.stackBarVersion + 1,
      })),
    },
    SEARCH_PANEL_TOGGLED: {
      actions: assign(({ context }) => ({
        searchPanelOpen: !context.searchPanelOpen,
        sortPanelOpen: false,
      })),
    },
    SORT_PANEL_TOGGLED: {
      actions: assign(({ context }) => ({
        sortPanelOpen: !context.sortPanelOpen,
        searchPanelOpen: false,
      })),
    },
    BROWSE_PANELS_CLOSED: {
      actions: assign({ searchPanelOpen: false, sortPanelOpen: false }),
    },
    LIST_REFRESH: {
      actions: assign(({ context }) => ({ listVersion: context.listVersion + 1 })),
    },
    REMINDERS_READY: {},
  },
});
