import type { FitViewOptions } from "@xyflow/react";

/** Measure at the time of fitting: toolbox wrapping, search and filters occupy real screen pixels. */
export function canvasFitPadding(ratio = 0.12): FitViewOptions["padding"] {
  if (typeof document === "undefined") return ratio;
  const wrap = document.querySelector(".canvas-wrap");
  const canvas = wrap?.querySelector(".react-flow");
  const toolbox = wrap?.querySelector(".toolbox");
  if (!canvas || !toolbox) return ratio;
  const viewport = canvas.getBoundingClientRect();
  const tools = toolbox.getBoundingClientRect();
  if (!tools.width || !tools.height || !viewport.height) return ratio;
  // Match React Flow's numeric padding convention on the other three sides.
  const base = (viewport.height - viewport.height / (1 + ratio)) / 2;
  const top = Math.ceil(Math.max(base, tools.bottom - viewport.top + 16));
  return { top: `${top}px`, bottom: ratio, left: ratio, right: ratio };
}
