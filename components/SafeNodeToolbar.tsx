"use client";

import { useCallback, useId, useLayoutEffect, useMemo, useState } from "react";
import { NodeToolbar, Position, useStore, useStoreApi, type NodeToolbarProps } from "@xyflow/react";

type Props = Omit<NodeToolbarProps, "nodeId" | "position" | "align"> & { nodeId: string | string[] };

/** Single and group toolbars share the same screen-space obstacle avoidance. */
export function SafeNodeToolbar(props: Props) {
  return props.isVisible ? <MeasuredToolbar {...props} /> : null;
}

function MeasuredToolbar({ nodeId, offset = 16, style, ...props }: Props) {
  const id = useId();
  const ids = useMemo(() => Array.isArray(nodeId) ? nodeId : [nodeId], [nodeId]);
  const store = useStoreApi();
  const geometry = useStore((state) => [state.width, state.height, ...state.transform,
    ...ids.flatMap((key) => {
      const node = state.nodeLookup.get(key);
      return node ? [node.internals.positionAbsolute.x, node.internals.positionAbsolute.y, node.measured.width, node.measured.height] : [];
    }),
  ].join("/"));
  const [placement, setPlacement] = useState({ position: Position.Top, dx: 0, dy: 0, ready: false });

  const measure = useCallback(() => {
    const bar = document.getElementById(id);
    const state = store.getState();
    const canvas = state.domNode;
    if (!bar || !canvas) return;
    const viewport = canvas.getBoundingClientRect();
    const [tx, ty, zoom] = state.transform;
    const rects = ids.flatMap((key) => {
      const node = state.nodeLookup.get(key);
      if (!node) return [];
      const left = viewport.left + tx + node.internals.positionAbsolute.x * zoom;
      const top = viewport.top + ty + node.internals.positionAbsolute.y * zoom;
      return [{ left, top, right: left + (node.measured.width || 0) * zoom, bottom: top + (node.measured.height || 0) * zoom }];
    });
    if (!rects.length) return;
    const bounds = {
      left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)),
    };
    const { width, height } = bar.getBoundingClientRect();
    const obstacles = [...(canvas.closest(".canvas-wrap") || canvas).querySelectorAll(
      ".toolbox > *, .toolbox .tb-more-panel, .react-flow__controls, .react-flow__minimap",
    )].map((element) => element.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const cx = (bounds.left + bounds.right) / 2, cy = (bounds.top + bounds.bottom) / 2;
    const candidates = [
      { position: Position.Top, left: cx - width / 2, top: bounds.top - offset - height },
      { position: Position.Bottom, left: cx - width / 2, top: bounds.bottom + offset },
      { position: Position.Right, left: bounds.right + offset, top: cy - height / 2 },
      { position: Position.Left, left: bounds.left - offset - width, top: cy - height / 2 },
    ].map((candidate) => {
      const left = Math.max(viewport.left + 8, Math.min(candidate.left, viewport.right - width - 8));
      const top = Math.max(viewport.top + 8, Math.min(candidate.top, viewport.bottom - height - 8));
      const overlap = obstacles.reduce((area, r) => area + Math.max(0, Math.min(left + width, r.right + 4) - Math.max(left, r.left - 4)) *
        Math.max(0, Math.min(top + height, r.bottom + 4) - Math.max(top, r.top - 4)), 0);
      return { position: candidate.position, dx: left - candidate.left, dy: top - candidate.top, overlap };
    });
    // Prefer top, then bottom; only use a side when neither fits. Clamping keeps edge cards usable.
    candidates.sort((a, b) => a.overlap - b.overlap);
    const { position, dx, dy } = candidates[0];
    setPlacement((before) => before.ready && before.position === position && Math.abs(before.dx - dx) < 0.1 && Math.abs(before.dy - dy) < 0.1
      ? before : { position, dx, dy, ready: true });
  }, [id, ids, offset, store]);

  useLayoutEffect(measure, [measure, geometry]);
  useLayoutEffect(() => {
    const canvas = store.getState().domNode;
    const bar = document.getElementById(id);
    if (!canvas || !bar) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(canvas);
    resize.observe(bar);
    const toolbox = canvas.closest(".canvas-wrap")?.querySelector(".toolbox");
    const mutation = new MutationObserver(schedule);
    if (toolbox) {
      resize.observe(toolbox);
      mutation.observe(toolbox, { childList: true, subtree: true, attributes: true });
    }
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("scroll", schedule, true);
    };
  }, [id, measure, store]);

  return <NodeToolbar {...props} id={id} nodeId={nodeId} offset={offset} position={placement.position}
    data-placement={placement.position}
    style={{ ...style, translate: `${placement.dx}px ${placement.dy}px`, visibility: placement.ready ? "visible" : "hidden" }} />;
}
