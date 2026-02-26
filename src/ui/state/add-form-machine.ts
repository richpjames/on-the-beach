export interface AddFormState {
  initialized: boolean;
  selectedStackIds: number[];
  scanState: "idle" | "scanning";
}

export type AddFormEvent =
  | { type: "INITIALIZED" }
  | { type: "STACK_TOGGLED"; stackId: number; checked: boolean }
  | { type: "STACK_ADDED"; stackId: number }
  | { type: "STACK_REMOVED"; stackId: number }
  | { type: "CLEAR_STACKS" }
  | { type: "SCAN_STARTED" }
  | { type: "SCAN_FINISHED" };

export const initialAddFormState: AddFormState = {
  initialized: false,
  selectedStackIds: [],
  scanState: "idle",
};

export function transitionAddFormState(state: AddFormState, event: AddFormEvent): AddFormState {
  switch (event.type) {
    case "INITIALIZED":
      return {
        ...state,
        initialized: true,
      };
    case "STACK_TOGGLED": {
      const exists = state.selectedStackIds.includes(event.stackId);
      if (event.checked && !exists) {
        return {
          ...state,
          selectedStackIds: [...state.selectedStackIds, event.stackId],
        };
      }

      if (!event.checked && exists) {
        return {
          ...state,
          selectedStackIds: state.selectedStackIds.filter((id) => id !== event.stackId),
        };
      }

      return state;
    }
    case "STACK_ADDED":
      if (state.selectedStackIds.includes(event.stackId)) {
        return state;
      }

      return {
        ...state,
        selectedStackIds: [...state.selectedStackIds, event.stackId],
      };
    case "STACK_REMOVED":
      return {
        ...state,
        selectedStackIds: state.selectedStackIds.filter((id) => id !== event.stackId),
      };
    case "CLEAR_STACKS":
      return {
        ...state,
        selectedStackIds: [],
      };
    case "SCAN_STARTED":
      return {
        ...state,
        scanState: "scanning",
      };
    case "SCAN_FINISHED":
      return {
        ...state,
        scanState: "idle",
      };
    default:
      return state;
  }
}
