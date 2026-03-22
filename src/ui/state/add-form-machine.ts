import { assign, fromPromise, setup } from "xstate";
import type { LinkReleaseCandidate } from "../../types";
import type { AddFormValues } from "../domain/add-form";
import { buildCreateMusicItemInputFromValues } from "../domain/add-form";
import { AmbiguousLinkApiError, type ApiClient } from "../../services/api-client";

type ScanResultData = {
  artist?: string;
  title?: string;
  artworkUrl?: string;
  year?: string;
  label?: string;
  country?: string;
  catalogueNumber?: string;
};

type AddFormValuesInput = AddFormValues;

export interface AddFormContext {
  api: ApiClient;
  initialized: boolean;
  selectedStackIds: number[];
  scanState: "idle" | "scanning";
  submitState: "idle" | "submitting" | "error";
  showSecondaryFields: boolean;
  pendingValues: AddFormValuesInput[] | null;
  createdItemId: number | null;
  linkPicker: {
    url: string;
    message: string;
    candidates: LinkReleaseCandidate[];
    selectedCandidateIds: string[];
    pendingValues: AddFormValuesInput;
  } | null;
  pendingScanBase64: string | null;
  scanResult: ScanResultData | null;
  scanError: string | null;
}

export type AddFormEvent =
  | { type: "INITIALIZED" }
  | { type: "STACK_TOGGLED"; stackId: number; checked: boolean }
  | { type: "STACK_ADDED"; stackId: number }
  | { type: "STACK_REMOVED"; stackId: number }
  | { type: "CLEAR_STACKS" }
  | { type: "SUBMIT_CLICKED"; url: string; pendingValues?: AddFormValuesInput }
  | {
      type: "LINK_PICKER_OPENED";
      url: string;
      message: string;
      candidates: LinkReleaseCandidate[];
      pendingValues: AddFormValuesInput;
    }
  | { type: "CANDIDATE_TOGGLED"; candidateId: string }
  | { type: "ALL_CANDIDATES_SELECTED" }
  | { type: "CANDIDATE_SUBMITTED" }
  | { type: "LINK_PICKER_CANCELLED" }
  | { type: "ENTER_MANUALLY" }
  | { type: "CLEAR_CREATED_ITEM" }
  | { type: "FORM_RESET" }
  | { type: "SCAN_FILE_SELECTED"; imageBase64: string }
  | { type: "SCAN_RESULT_CONSUMED" };

export const addFormMachine = setup({
  types: {} as {
    context: AddFormContext;
    events: AddFormEvent;
    input: { api: ApiClient };
  },
  actors: {
    scanCover: fromPromise<ScanResultData, { api: ApiClient; imageBase64: string }>(
      async ({ input }) => {
        const { api, imageBase64 } = input;
        const [uploadResult, scanResult] = await Promise.all([
          api.uploadReleaseImage(imageBase64),
          api.scanCover(imageBase64),
        ]);
        return {
          artworkUrl: uploadResult.artworkUrl,
          artist: scanResult.artist ?? undefined,
          title: scanResult.title ?? undefined,
          year: scanResult.year != null ? String(scanResult.year) : undefined,
          label: scanResult.label ?? undefined,
          country: scanResult.country ?? undefined,
          catalogueNumber: scanResult.catalogueNumber ?? undefined,
        };
      },
    ),
    submitItem: fromPromise<
      { itemId: number },
      { api: ApiClient; valuesArray: AddFormValuesInput[]; selectedStackIds: number[] }
    >(async ({ input }) => {
      const { api, valuesArray, selectedStackIds } = input;

      const submitOne = async (values: AddFormValuesInput): Promise<number> => {
        // Enrich with MusicBrainz (non-fatal)
        let enrichedValues = { ...values };
        let musicbrainzReleaseId: string | undefined;
        let musicbrainzArtistId: string | undefined;

        if (values.artist.trim() && values.title.trim()) {
          try {
            const enrichment = await api.lookupRelease(
              values.artist.trim(),
              values.title.trim(),
              values.year.trim() || undefined,
            );
            if (enrichment.year != null && !values.year.trim())
              enrichedValues.year = String(enrichment.year);
            if (enrichment.label && !values.label.trim()) enrichedValues.label = enrichment.label;
            if (enrichment.country && !values.country.trim())
              enrichedValues.country = enrichment.country;
            if (enrichment.catalogueNumber && !values.catalogueNumber.trim())
              enrichedValues.catalogueNumber = enrichment.catalogueNumber;
            if (enrichment.artworkUrl && !values.artworkUrl.trim())
              enrichedValues.artworkUrl = enrichment.artworkUrl;
            if (enrichment.musicbrainzReleaseId)
              musicbrainzReleaseId = enrichment.musicbrainzReleaseId;
            if (enrichment.musicbrainzArtistId)
              musicbrainzArtistId = enrichment.musicbrainzArtistId;
          } catch {
            // non-fatal
          }
        }

        const item = await api.createMusicItem({
          ...buildCreateMusicItemInputFromValues(enrichedValues),
          listenStatus: "to-listen",
          musicbrainzReleaseId,
          musicbrainzArtistId,
        });

        if (selectedStackIds.length > 0) {
          await api.setItemStacks(item.id, selectedStackIds);
        }

        return item.id;
      };

      const itemIds = await Promise.all(valuesArray.map(submitOne));
      return { itemId: itemIds[itemIds.length - 1] };
    }),
  },
}).createMachine({
  context: ({ input }) => ({
    api: input.api,
    initialized: false,
    selectedStackIds: [],
    scanState: "idle",
    submitState: "idle",
    showSecondaryFields: false,
    pendingValues: null,
    createdItemId: null,
    linkPicker: null,
    pendingScanBase64: null,
    scanResult: null,
    scanError: null,
  }),
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

    CLEAR_CREATED_ITEM: {
      actions: assign({ createdItemId: null }),
    },
    FORM_RESET: {
      target: ".idle",
      actions: assign({
        showSecondaryFields: false,
        linkPicker: null,
        submitState: "idle" as const,
        pendingValues: null,
        createdItemId: null,
        pendingScanBase64: null,
        scanResult: null,
        scanError: null,
      }),
    },
    SCAN_FILE_SELECTED: {
      guard: ({ context }) => context.submitState !== "submitting",
      target: ".scanning",
      actions: assign(({ event }) => ({
        pendingScanBase64: event.imageBase64,
        scanState: "scanning" as const,
      })),
    },
    SCAN_RESULT_CONSUMED: {
      actions: assign({ scanResult: null, scanError: null }),
    },
  },
  states: {
    idle: {
      on: {
        SUBMIT_CLICKED: [
          {
            guard: ({ event }) => !event.url.trim(),
            target: "enteringManually",
            actions: assign({ showSecondaryFields: true }),
          },
          {
            // url is present — go to submitting
            target: "submitting",
            actions: assign(({ event }) => ({
              pendingValues: event.pendingValues ? [event.pendingValues] : null,
              submitState: "submitting" as const,
            })),
          },
        ],
        LINK_PICKER_OPENED: {
          target: "linkPickerOpen",
          actions: assign(({ event }) => ({
            linkPicker: {
              url: event.url,
              message: event.message,
              candidates: event.candidates,
              selectedCandidateIds: [],
              pendingValues: event.pendingValues,
            },
          })),
        },
      },
    },
    enteringManually: {
      on: {
        SUBMIT_CLICKED: {
          guard: ({ event }) =>
            event.pendingValues != null &&
            !!(
              event.url?.trim() ||
              event.pendingValues.title?.trim() ||
              event.pendingValues.artist?.trim()
            ),
          target: "submitting",
          actions: assign(({ event }) => ({
            pendingValues: event.pendingValues ? [event.pendingValues] : null,
            submitState: "submitting" as const,
          })),
        },
        LINK_PICKER_OPENED: {
          target: "linkPickerOpen",
          actions: assign(({ event }) => ({
            linkPicker: {
              url: event.url,
              message: event.message,
              candidates: event.candidates,
              selectedCandidateIds: [],
              pendingValues: event.pendingValues,
            },
          })),
        },
      },
    },
    linkPickerOpen: {
      on: {
        CANDIDATE_TOGGLED: {
          actions: assign(({ context, event }) => {
            if (!context.linkPicker) return {};
            const ids = context.linkPicker.selectedCandidateIds;
            const isSelected = ids.includes(event.candidateId);
            return {
              linkPicker: {
                ...context.linkPicker,
                selectedCandidateIds: isSelected
                  ? ids.filter((id) => id !== event.candidateId)
                  : [...ids, event.candidateId],
              },
            };
          }),
        },
        ALL_CANDIDATES_SELECTED: {
          actions: assign(({ context }) => ({
            linkPicker: context.linkPicker
              ? {
                  ...context.linkPicker,
                  selectedCandidateIds: context.linkPicker.candidates.map((c) => c.candidateId),
                }
              : null,
          })),
        },
        CANDIDATE_SUBMITTED: {
          guard: ({ context }) => (context.linkPicker?.selectedCandidateIds.length ?? 0) > 0,
          target: "submitting",
          actions: assign(({ context }) => {
            const { selectedCandidateIds, candidates, pendingValues: base } = context.linkPicker!;
            const selectedCandidates = selectedCandidateIds
              .map((id) => candidates.find((c) => c.candidateId === id))
              .filter((c): c is LinkReleaseCandidate => c != null);
            return {
              pendingValues:
                selectedCandidates.length > 0
                  ? selectedCandidates.map((candidate) => ({
                      ...base,
                      artist: candidate.artist ?? base.artist,
                      title: candidate.title || base.title,
                      itemType: candidate.itemType ?? base.itemType,
                    }))
                  : [base],
              submitState: "submitting" as const,
              linkPicker: null,
            };
          }),
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
    scanning: {
      invoke: {
        src: "scanCover",
        input: ({ context }) => ({
          api: context.api,
          imageBase64: context.pendingScanBase64!,
        }),
        onDone: [
          {
            guard: ({ context }) => context.showSecondaryFields,
            target: "enteringManually",
            actions: assign(({ event }) => ({
              scanState: "idle" as const,
              scanResult: event.output,
              pendingScanBase64: null,
              scanError: null,
            })),
          },
          {
            target: "enteringManually",
            actions: assign(({ event }) => ({
              scanState: "idle" as const,
              scanResult: event.output,
              pendingScanBase64: null,
              scanError: null,
              showSecondaryFields: true,
            })),
          },
        ],
        onError: [
          {
            guard: ({ context }) => context.showSecondaryFields,
            target: "enteringManually",
            actions: assign(({ event }) => ({
              scanState: "idle" as const,
              scanError: String(event.error),
              pendingScanBase64: null,
              scanResult: null,
            })),
          },
          {
            target: "idle",
            actions: assign(({ event }) => ({
              scanState: "idle" as const,
              scanError: String(event.error),
              pendingScanBase64: null,
              scanResult: null,
            })),
          },
        ],
      },
    },
    submitting: {
      invoke: {
        src: "submitItem",
        input: ({ context }) => ({
          api: context.api,
          valuesArray: context.pendingValues!,
          selectedStackIds: context.selectedStackIds,
        }),
        onDone: {
          target: "idle",
          actions: assign(({ event }) => ({
            submitState: "idle" as const,
            createdItemId: event.output.itemId,
            pendingValues: null,
            showSecondaryFields: false,
            selectedStackIds: [],
          })),
        },
        onError: [
          {
            guard: ({ event }) => event.error instanceof AmbiguousLinkApiError,
            target: "linkPickerOpen",
            actions: assign(({ event, context }) => ({
              submitState: "idle" as const,
              linkPicker: {
                url: (event.error as AmbiguousLinkApiError).payload.url,
                message: (event.error as AmbiguousLinkApiError).payload.message,
                candidates: (event.error as AmbiguousLinkApiError).payload.candidates,
                selectedCandidateIds: [],
                pendingValues: context.pendingValues![0],
              },
            })),
          },
          {
            target: "idle",
            actions: assign({ submitState: "error" as const }),
          },
        ],
      },
    },
  },
});
