import type { EvalEndpoint, EvalModelKind } from "./types";

export interface EvalModelConfig {
  id: string;
  kind: EvalModelKind;
  endpoint: EvalEndpoint;
}

export const VISION_MODELS: EvalModelConfig[] = [
  { id: "mistral-ocr-latest", kind: "ocr", endpoint: "/v1/ocr" },
  { id: "mistral-small-2506", kind: "chat", endpoint: "/v1/chat/completions" },
  { id: "mistral-medium-2508", kind: "chat", endpoint: "/v1/chat/completions" },
];

export function getVisionModelConfigById(modelId: string): EvalModelConfig | null {
  return VISION_MODELS.find((model) => model.id === modelId) ?? null;
}
