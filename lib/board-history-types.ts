/** Public summaries only; changed card/comment contents stay in private storage. */
export interface BoardHistoryItem {
  id: string;
  at: number;
  label: string;
  applied: boolean;
  changes: number;
}
export interface BoardHistoryState {
  entries: BoardHistoryItem[];
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  cursor: number;
  limit: number;
  maxBytes: number;
  warning: string | null;
}
