export interface Dimensions {
  width: number;
  height: number;
}

export function constrainDimensions(width: number, height: number, maxEdge: number): Dimensions {
  const largestEdge = Math.max(width, height);
  if (largestEdge <= maxEdge) {
    return { width, height };
  }

  const scale = maxEdge / largestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
