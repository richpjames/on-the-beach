import type { ListenStatus } from "../../types";

export type DisplayListenStatus = Exclude<ListenStatus, "listening">;

export const STATUS_LABELS: Record<DisplayListenStatus, string> = {
  "to-listen": "To Listen",
  listened: "Listened",
  "to-revisit": "Revisit",
  done: "Done",
};
