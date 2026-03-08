import { assign, createMachine } from "xstate";

export interface AddFormContext {
  initialized: boolean;
  selectedStackIds: number[];
  scanState: "idle" | "scanning";
  submitState: "idle" | "submitting" | "error";
}

export type AddFormEvent =
  | { type: "INITIALIZED" }
  | { type: "STACK_TOGGLED"; stackId: number; checked: boolean }
  | { type: "STACK_ADDED"; stackId: number }
  | { type: "STACK_REMOVED"; stackId: number }
  | { type: "CLEAR_STACKS" }
  | { type: "SCAN_STARTED" }
  | { type: "SCAN_FINISHED" }
  | { type: "SUBMIT_STARTED" }
  | { type: "SUBMIT_FINISHED" }
  | { type: "SUBMIT_ERROR" };

export const addFormMachine = createMachine({
  types: {} as { context: AddFormContext; events: AddFormEvent },
  context: {
    initialized: false,
    selectedStackIds: [],
    scanState: "idle",
    submitState: "idle",
  },
  on: {
    INITIALIZED: {
      actions: assign({ initialized: true }),
    },
    STACK_TOGGLED: {
      actions: assign(({ context, event }) => {
        const exists = context.selectedStackIds.includes(event.stackId);
        if (event.checked && !exists) {
          return { selectedStackIds: [...context.selectedStackIds, event.stackId] };
        }
        if (!event.checked && exists) {
          return {
            selectedStackIds: context.selectedStackIds.filter((id) => id !== event.stackId),
          };
        }
        return {};
      }),
    },
    STACK_ADDED: {
      actions: assign(({ context, event }) => {
        if (context.selectedStackIds.includes(event.stackId)) return {};
        return { selectedStackIds: [...context.selectedStackIds, event.stackId] };
      }),
    },
    STACK_REMOVED: {
      actions: assign(({ context, event }) => ({
        selectedStackIds: context.selectedStackIds.filter((id) => id !== event.stackId),
      })),
    },
    CLEAR_STACKS: {
      actions: assign({ selectedStackIds: [] }),
    },
    SCAN_STARTED: {
      actions: assign({ scanState: "scanning" as const }),
    },
    SCAN_FINISHED: {
      actions: assign({ scanState: "idle" as const }),
    },
    SUBMIT_STARTED: {
      actions: assign({ submitState: "submitting" as const }),
    },
    SUBMIT_FINISHED: {
      actions: assign({ submitState: "idle" as const }),
    },
    SUBMIT_ERROR: {
      actions: assign({ submitState: "error" as const }),
    },
  },
});
