import type { EvalEndpoint, EvalModelKind } from "./types";

export interface EvalModelConfig {
  id: string;
  kind: EvalModelKind;
  endpoint: EvalEndpoint;
}

export const VISION_MODELS: EvalModelConfig[] = [
  {
    id: "mistral-small-2506",
    kind: "chat",
    endpoint: "/v1/chat/completions",
  },
  {
    id: "magistral-small-2509",
    kind: "chat",
    endpoint: "/v1/chat/completions",
  },
];

export const OCR_TEXT_PARSER_MODELS: string[] = ["mistral-small-2506"];

export function getVisionModelConfigById(modelId: string): EvalModelConfig | null {
  return VISION_MODELS.find((model) => model.id === modelId) ?? null;
}
