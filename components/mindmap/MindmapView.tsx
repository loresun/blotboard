"use client";

/**
 * 思维导图渲染（卡面缩略 + 弹窗编辑共用同一个组件）。
 *
 * 为什么不引导图库：这里要的就是「飞书思维笔记」那一种——横向树、根节点一个色块、
 * 圆角折线把父子连起来。用 flex 排版让父节点自动落在子树的垂直中点，再量一遍位置用 SVG 画折线，
 * 比拉一个库进来更好控样式，数据也仍是纯 { id, text, children }。
 *
 * 布局两种：`right` 全部往右展开；`both` 根节点居中、子节点左右分叉。
 * `fit` 打开时整张图等比缩到容器里并居中——卡面上用它，弹窗里按 1:1 显示。
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import type { MindLayout, MindNode, MindTheme } from "@/lib/types";

/** 父子两层之间留给折线的水平距离 */
const GAP = 56;
/** 折线拐角半径 */
const RADIUS = 12;

type Dir = 1 | -1;

/** 一支挂了多少叶子——用它衡量子树「占多高」 */
function leafCount(node: MindNode): number {
  const children = node.collapsed ? [] : node.children || [];
  if (!children.length) return 1;
  return children.reduce((sum, child) => sum + leafCount(child), 0);
}

/**
 * 左右分叉时怎么切：按叶子数累计到一半再切，而不是按分支个数对半。
 * 分支的胖瘦差很多时（一支挂 4 个、另一支挂 1 个），对半切会让一边长出去一大截。
 */
function splitBoth(children: MindNode[]): { right: MindNode[]; left: MindNode[] } {
  const weights = children.map(leafCount);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let acc = 0;
  let cut = children.length;
  for (let index = 0; index < children.length; index += 1) {
    acc += weights[index];
    if (acc * 2 >= total) {
      cut = index + 1;
      break;
    }
  }
  // 至少给左边留一支，否则「分叉」跟「全向右」没区别
  if (cut >= children.length) cut = children.length - 1;
  return { right: children.slice(0, cut), left: children.slice(cut) };
}

interface Pair {
  from: string;
  to: string;
  dir: Dir;
}

/** 把要连的父子对摊平出来——渲染与画线各走各的，省得在递归里塞副作用 */
function collectPairs(node: MindNode, dir: Dir, out: Pair[], layout: MindLayout, depth = 0): void {
  const children = node.collapsed ? [] : node.children || [];
  if (layout === "both" && depth === 0 && children.length > 1) {
    const { right, left } = splitBoth(children);
    for (const child of right) {
      out.push({ from: node.id, to: child.id, dir: 1 });
      collectPairs(child, 1, out, layout, depth + 1);
    }
    for (const child of left) {
      out.push({ from: node.id, to: child.id, dir: -1 });
      collectPairs(child, -1, out, layout, depth + 1);
    }
    return;
  }
  for (const child of children) {
    out.push({ from: node.id, to: child.id, dir });
    collectPairs(child, dir, out, layout, depth + 1);
  }
}

interface Box {
  left: number;
  right: number;
  cy: number;
}

/** 圆角折线：父节点侧边水平出线 → 中途拐两个圆角 → 水平进子节点 */
function elbow(from: Box, to: Box, dir: Dir): string {
  const px = dir === 1 ? from.right : from.left;
  const cx = dir === 1 ? to.left : to.right;
  const py = from.cy;
  const cy = to.cy;
  if (Math.abs(cy - py) < 0.8) return `M ${px} ${py} L ${cx} ${cy}`;

  const mx = px + (cx - px) * 0.45;
  const vertical = Math.sign(cy - py);
  const radius = Math.min(RADIUS, Math.abs(cy - py) / 2, Math.abs(mx - px), Math.abs(cx - mx));
  const h = dir; // 水平前进方向
  return [
    `M ${px} ${py}`,
    `L ${mx - radius * h} ${py}`,
    `Q ${mx} ${py} ${mx} ${py + radius * vertical}`,
    `L ${mx} ${cy - radius * vertical}`,
    `Q ${mx} ${cy} ${mx + radius * h} ${cy}`,
    `L ${cx} ${cy}`,
  ].join(" ");
}

export interface MindmapViewProps {
  root: MindNode;
  layout?: MindLayout;
  theme?: MindTheme;
  /** 等比缩放并居中到容器里（卡面用） */
  fit?: boolean;
  /** 可编辑：节点变成自适应宽度的输入框 */
  editable?: boolean;
  onChangeText?: (nodeId: string, text: string) => void;
  onToggleCollapse?: (nodeId: string) => void;
  onNodeKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>, node: MindNode) => void;
  onFocusNode?: (nodeId: string) => void;
  /** 想让哪个节点拿到焦点（新建节点后指过去） */
  autoFocusId?: string | null;
}

export function MindmapView({
  root,
  layout = "right",
  theme = "classic",
  fit = false,
  editable = false,
  onChangeText,
  onToggleCollapse,
  onNodeKeyDown,
  onFocusNode,
  autoFocusId,
}: MindmapViewProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const t = useT();
  const [paths, setPaths] = useState<string[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scale, setScale] = useState(1);

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    // offsetWidth 不受 transform 影响，拿到的是「没缩放时的自然尺寸」
    const naturalW = canvas.offsetWidth;
    const naturalH = canvas.offsetHeight;
    const nextScale = fit
      ? Math.min(1, (wrap.clientWidth - 8) / Math.max(naturalW, 1), (wrap.clientHeight - 8) / Math.max(naturalH, 1))
      : 1;

    // 用 offsetLeft/offsetTop 而不是 getBoundingClientRect：
    // 它们是布局坐标，不受 .mv-scale 的 transform 影响，所以缩放中途也不会算错。
    // （前提：.mv-canvas 是 position:relative，且它到 label 之间没有别的定位祖先）
    const boxOf = (id: string): Box | null => {
      const el = canvas.querySelector<HTMLElement>(`[data-mid="${id}"]`);
      if (!el || el.offsetParent !== canvas) return null;
      return {
        left: el.offsetLeft,
        right: el.offsetLeft + el.offsetWidth,
        cy: el.offsetTop + el.offsetHeight / 2,
      };
    };

    const pairs: Pair[] = [];
    collectPairs(root, 1, pairs, layout);
    const next = pairs
      .map((pair) => {
        const from = boxOf(pair.from);
        const to = boxOf(pair.to);
        return from && to ? elbow(from, to, pair.dir) : null;
      })
      .filter((path): path is string => Boolean(path));

    setPaths((prev) => (prev.length === next.length && prev.every((p, i) => p === next[i]) ? prev : next));
    setSize((prev) => (prev.w === naturalW && prev.h === naturalH ? prev : { w: naturalW, h: naturalH }));
    setScale((prev) => (Math.abs(prev - nextScale) < 0.001 ? prev : nextScale));
  }, [root, layout, fit]);

  useLayoutEffect(() => {
    measure();
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(wrap);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [measure]);

  function renderLabel(node: MindNode, depth: number, dir: Dir = 1) {
    const level = depth === 0 ? "root" : depth === 1 ? "branch" : "leaf";
    const kids = node.children || [];
    return (
      <span className={`mv-slot lv-${level}${dir === -1 ? " to-left" : ""}`}>
        {kids.length && onToggleCollapse ? (
          <button
            type="button"
            className="mv-fold"
            title={t(node.collapsed ? "canvas.mindmap.expand" : "canvas.mindmap.collapse")}
            onClick={() => onToggleCollapse(node.id)}
          >
            {node.collapsed ? kids.length : "−"}
          </button>
        ) : null}
        <span className="mv-label" data-mid={node.id}>
          <span className="mv-fit">
            <span className="mv-ghost">{node.text || t(depth === 0 ? "canvas.mindmap.root" : "canvas.mindmap.branch")}</span>
            {editable ? (
              <input
                className="mv-input"
                value={node.text}
                placeholder={t(depth === 0 ? "canvas.mindmap.root" : "canvas.mindmap.branch")}
                autoFocus={autoFocusId === node.id}
                onFocus={() => onFocusNode?.(node.id)}
                onChange={(event) => onChangeText?.(node.id, event.target.value)}
                onKeyDown={(event) => onNodeKeyDown?.(event, node)}
              />
            ) : (
              <span className="mv-text">{node.text || t(depth === 0 ? "canvas.mindmap.root" : "canvas.mindmap.branch")}</span>
            )}
          </span>
        </span>
      </span>
    );
  }

  function renderBranch(node: MindNode, depth: number, dir: Dir) {
    const children = node.collapsed ? [] : node.children || [];
    return (
      <div className={`mv-branch d${Math.min(depth, 3)}${dir === -1 ? " to-left" : ""}`} key={node.id}>
        {renderLabel(node, depth, dir)}
        {children.length ? (
          <div className="mv-kids">{children.map((child) => renderBranch(child, depth + 1, dir))}</div>
        ) : null}
      </div>
    );
  }

  function renderTree() {
    const children = root.collapsed ? [] : root.children || [];
    if (layout !== "both" || children.length < 2) return renderBranch(root, 0, 1);
    const { right, left } = splitBoth(children);
    return (
      <div className="mv-both">
        <div className="mv-kids side-left">{left.map((child) => renderBranch(child, 1, -1))}</div>
        {renderLabel(root, 0)}
        <div className="mv-kids">{right.map((child) => renderBranch(child, 1, 1))}</div>
      </div>
    );
  }

  return (
    <div className={`mv th-${theme}${fit ? " fit" : ""}`} ref={wrapRef}>
      <div className="mv-scale" style={fit ? { transform: `scale(${scale})` } : undefined}>
        <div className="mv-canvas" ref={canvasRef}>
          <svg className="mv-links" width={size.w || 1} height={size.h || 1} aria-hidden>
            {paths.map((d, index) => (
              <path key={index} d={d} />
            ))}
          </svg>
          {renderTree()}
        </div>
      </div>
    </div>
  );
}
