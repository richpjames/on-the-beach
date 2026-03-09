import type { ListenStatus } from "../../types";

export type DisplayListenStatus = ListenStatus;

export const STATUS_LABELS: Record<DisplayListenStatus, string> = {
  "to-listen": "To Listen",
  listened: "Listened",
  done: "Done",
};
