export interface RatingClearCandidate {
  id: number;
  value: number;
}

export interface RatingState {
  clearCandidate: RatingClearCandidate | null;
}

export type RatingEvent =
  | { type: "POINTER_DOWN_ON_CHECKED"; itemId: number; value: number }
  | { type: "RESET" };

export interface RatingClickResult {
  shouldClear: boolean;
  state: RatingState;
}

export const initialRatingState: RatingState = {
  clearCandidate: null,
};

export function transitionRatingState(state: RatingState, event: RatingEvent): RatingState {
  switch (event.type) {
    case "POINTER_DOWN_ON_CHECKED":
      return {
        ...state,
        clearCandidate: {
          id: event.itemId,
          value: event.value,
        },
      };
    case "RESET":
      return {
        ...state,
        clearCandidate: null,
      };
    default:
      return state;
  }
}

export function resolveRatingClick(
  state: RatingState,
  itemId: number,
  value: number,
): RatingClickResult {
  const candidate = state.clearCandidate;
  const shouldClear = candidate !== null && candidate.id === itemId && candidate.value === value;

  return {
    shouldClear,
    state: transitionRatingState(state, { type: "RESET" }),
  };
}
