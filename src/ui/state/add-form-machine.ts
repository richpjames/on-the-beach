import { assign, setup } from "xstate";
import type { LinkReleaseCandidate } from "../../types";
import type { AddFormValues } from "../domain/add-form";

type AddFormValuesInput = AddFormValues;

export interface AddFormContext {
  initialized: boolean;
  selectedStackIds: number[];
  scanState: "idle" | "scanning";
  submitState: "idle" | "submitting" | "error";
  showSecondaryFields: boolean;
  linkPicker: {
    url: string;
    message: string;
    candidates: LinkReleaseCandidate[];
    selectedCandidateId: string | null;
    pendingValues: AddFormValuesInput;
  } | null;
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
  | { type: "SUBMIT_ERROR" }
  | { type: "SUBMIT_CLICKED"; url: string }
  | {
      type: "LINK_PICKER_OPENED";
      url: string;
      message: string;
      candidates: LinkReleaseCandidate[];
      pendingValues: AddFormValuesInput;
    }
  | { type: "CANDIDATE_SELECTED"; candidateId: string }
  | { type: "LINK_PICKER_CANCELLED" }
  | { type: "ENTER_MANUALLY" }
  | { type: "FORM_RESET" };

export const addFormMachine = setup({
  types: {} as { context: AddFormContext; events: AddFormEvent },
}).createMachine({
  context: {
    initialized: false,
    selectedStackIds: [],
    scanState: "idle",
    submitState: "idle",
    showSecondaryFields: false,
    linkPicker: null,
  },
  initial: "idle",
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
    FORM_RESET: {
      target: ".idle",
      actions: assign({ showSecondaryFields: false, linkPicker: null }),
    },
  },
  states: {
    idle: {
      on: {
        SUBMIT_CLICKED: [
          {
            guard: ({ event }) => event.url === "",
            target: "enteringManually",
            actions: assign({ showSecondaryFields: true }),
          },
          // url is not empty — no-op for now (Task 2 will handle async submit)
        ],
        LINK_PICKER_OPENED: {
          target: "linkPickerOpen",
          actions: assign(({ event }) => ({
            linkPicker: {
              url: event.url,
              message: event.message,
              candidates: event.candidates,
              selectedCandidateId: null,
              pendingValues: event.pendingValues,
            },
          })),
        },
      },
    },
    enteringManually: {
      on: {
        LINK_PICKER_OPENED: {
          target: "linkPickerOpen",
          actions: assign(({ event }) => ({
            linkPicker: {
              url: event.url,
              message: event.message,
              candidates: event.candidates,
              selectedCandidateId: null,
              pendingValues: event.pendingValues,
            },
          })),
        },
      },
    },
    linkPickerOpen: {
      on: {
        CANDIDATE_SELECTED: {
          actions: assign(({ context, event }) => ({
            linkPicker: context.linkPicker
              ? { ...context.linkPicker, selectedCandidateId: event.candidateId }
              : null,
          })),
        },
        LINK_PICKER_CANCELLED: {
          target: "idle",
          actions: assign({ linkPicker: null }),
        },
        ENTER_MANUALLY: {
          target: "enteringManually",
          actions: assign({ showSecondaryFields: true, linkPicker: null }),
        },
      },
    },
  },
});
