import type { ListenStatus, StackWithCount } from "../../types";

export interface AppState {
  currentFilter: ListenStatus | "all";
  currentStack: number | null;
  stacks: StackWithCount[];
  isReady: boolean;
  stackManageOpen: boolean;
}

export type AppEvent =
  | { type: "APP_READY" }
  | { type: "FILTER_SELECTED"; filter: ListenStatus | "all" }
  | { type: "STACK_SELECTED"; stackId: number }
  | { type: "STACK_SELECTED_ALL" }
  | { type: "STACKS_LOADED"; stacks: StackWithCount[] }
  | { type: "STACK_MANAGE_TOGGLED" }
  | { type: "STACK_DELETED"; stackId: number };

export const initialAppState: AppState = {
  currentFilter: "to-listen",
  currentStack: null,
  stacks: [],
  isReady: false,
  stackManageOpen: false,
};

export function transitionAppState(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "APP_READY":
      return {
        ...state,
        isReady: true,
      };
    case "FILTER_SELECTED":
      return {
        ...state,
        currentFilter: event.filter,
      };
    case "STACK_SELECTED":
      return {
        ...state,
        currentStack: event.stackId,
      };
    case "STACK_SELECTED_ALL":
      return {
        ...state,
        currentStack: null,
      };
    case "STACKS_LOADED":
      return {
        ...state,
        stacks: event.stacks,
      };
    case "STACK_MANAGE_TOGGLED":
      return {
        ...state,
        stackManageOpen: !state.stackManageOpen,
      };
    case "STACK_DELETED":
      return {
        ...state,
        currentStack: state.currentStack === event.stackId ? null : state.currentStack,
        stacks: state.stacks.filter((stack) => stack.id !== event.stackId),
      };
    default:
      return state;
  }
}
