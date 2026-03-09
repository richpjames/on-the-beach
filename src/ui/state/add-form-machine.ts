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
  pendingValues: AddFormValuesInput | null;
  createdItemId: number | null;
  linkPicker: {
    url: string;
    message: string;
    candidates: LinkReleaseCandidate[];
    selectedCandidateId: string | null;
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
  | { type: "SCAN_STARTED" }
  | { type: "SCAN_FINISHED" }
  | { type: "SUBMIT_STARTED" }
  | { type: "SUBMIT_FINISHED" }
  | { type: "SUBMIT_ERROR" }
  | { type: "SUBMIT_CLICKED"; url: string; pendingValues?: AddFormValuesInput }
  | {
      type: "LINK_PICKER_OPENED";
      url: string;
      message: string;
      candidates: LinkReleaseCandidate[];
      pendingValues: AddFormValuesInput;
    }
  | { type: "CANDIDATE_SELECTED"; candidateId: string }
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
      { api: ApiClient; values: AddFormValuesInput; selectedStackIds: number[] }
    >(async ({ input }) => {
      const { api, values, selectedStackIds } = input;

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
          if (enrichment.musicbrainzArtistId) musicbrainzArtistId = enrichment.musicbrainzArtistId;
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

      return { itemId: item.id };
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
              pendingValues: event.pendingValues ?? null,
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
              selectedCandidateId: null,
              pendingValues: event.pendingValues,
            },
          })),
        },
      },
    },
    enteringManually: {
      on: {
        SUBMIT_CLICKED: {
          guard: ({ event }) => event.pendingValues != null,
          target: "submitting",
          actions: assign(({ event }) => ({
            pendingValues: event.pendingValues,
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
        CANDIDATE_SUBMITTED: {
          guard: ({ context }) => context.linkPicker?.selectedCandidateId != null,
          target: "submitting",
          actions: assign(({ context }) => {
            const candidate = context.linkPicker!.candidates.find(
              (c) => c.candidateId === context.linkPicker!.selectedCandidateId,
            );
            const base = context.linkPicker!.pendingValues;
            return {
              pendingValues: candidate
                ? {
                    ...base,
                    artist: candidate.artist ?? base.artist,
                    title: candidate.title || base.title,
                    itemType: candidate.itemType ?? base.itemType,
                  }
                : base,
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
        onDone: {
          target: "idle",
          actions: assign(({ event }) => ({
            scanState: "idle" as const,
            scanResult: event.output,
            pendingScanBase64: null,
            scanError: null,
          })),
        },
        onError: {
          target: "idle",
          actions: assign(({ event }) => ({
            scanState: "idle" as const,
            scanError: String(event.error),
            pendingScanBase64: null,
            scanResult: null,
          })),
        },
      },
    },
    submitting: {
      invoke: {
        src: "submitItem",
        input: ({ context }) => ({
          api: context.api,
          values: context.pendingValues!,
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
                selectedCandidateId: null,
                pendingValues: context.pendingValues!,
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
