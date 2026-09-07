/**
 * 思维导图的树操作（纯函数，不碰 React）。
 *
 * 刻意不引第三方导图库：卡面缩略与抽屉编辑共用同一份 CSS 横向树，
 * 数据就是一棵 { id, text, children } —— 存进画板 JSON、导出成缩进列表、喂给 agent 都不用转换。
 */
import type { MindNode, MindmapField } from "./types";

export function newMindId(): string {
  return `m_${Math.random().toString(36).slice(2, 10)}`;
}

export function makeNode(text = ""): MindNode {
  return { id: newMindId(), text, children: [] };
}

export function emptyMindmap(topic = "中心主题"): MindmapField {
  return {
    root: { ...makeNode(topic), children: [makeNode("分支一"), makeNode("分支二")] },
  };
}

/** 深拷贝改一个节点；找不到就原样返回（调用方不用做存在性判断）。 */
export function updateNode(node: MindNode, id: string, mutate: (target: MindNode) => MindNode): MindNode {
  if (node.id === id) return mutate(node);
  return { ...node, children: (node.children || []).map((child) => updateNode(child, id, mutate)) };
}

export function addChild(root: MindNode, parentId: string, text = ""): { root: MindNode; created: MindNode } {
  const created = makeNode(text);
  const next = updateNode(root, parentId, (target) => ({
    ...target,
    collapsed: false,
    children: [...(target.children || []), created],
  }));
  return { root: next, created };
}

export function addSibling(root: MindNode, nodeId: string, text = ""): { root: MindNode; created: MindNode | null } {
  if (root.id === nodeId) return { root, created: null }; // 根节点没有兄弟
  const created = makeNode(text);
  const walk = (node: MindNode): MindNode => {
    const children = node.children || [];
    const index = children.findIndex((child) => child.id === nodeId);
    if (index >= 0) {
      const next = [...children];
      next.splice(index + 1, 0, created);
      return { ...node, children: next };
    }
    return { ...node, children: children.map(walk) };
  };
  return { root: walk(root), created };
}

export function removeNode(root: MindNode, nodeId: string): MindNode {
  if (root.id === nodeId) return root; // 根节点不能删
  const walk = (node: MindNode): MindNode => ({
    ...node,
    children: (node.children || []).filter((child) => child.id !== nodeId).map(walk),
  });
  return walk(root);
}

/** 上下移动一个节点在兄弟里的位置。 */
export function moveNode(root: MindNode, nodeId: string, delta: -1 | 1): MindNode {
  const walk = (node: MindNode): MindNode => {
    const children = node.children || [];
    const index = children.findIndex((child) => child.id === nodeId);
    if (index >= 0) {
      const target = index + delta;
      if (target < 0 || target >= children.length) return node;
      const next = [...children];
      [next[index], next[target]] = [next[target], next[index]];
      return { ...node, children: next };
    }
    return { ...node, children: children.map(walk) };
  };
  return walk(root);
}

export function countNodes(node: MindNode): number {
  return 1 + (node.children || []).reduce((sum, child) => sum + countNodes(child), 0);
}

/** 缩进列表 ⇄ 树：粘贴大纲直接变导图，是最省事的批量录入方式。 */
export function outlineToMindmap(text: string): MindmapField | null {
  const lines = text.split("\n").filter((line) => line.trim());
  if (!lines.length) return null;
  const parsed = lines.map((line) => {
    const indent = (line.match(/^[\t ]*/)?.[0] || "").replace(/\t/g, "  ").length;
    return { depth: Math.floor(indent / 2), text: line.trim().replace(/^[-*+]\s*/, "") };
  });
  const root = makeNode(parsed[0].text);
  const stack: { depth: number; node: MindNode }[] = [{ depth: parsed[0].depth, node: root }];
  for (const line of parsed.slice(1)) {
    while (stack.length > 1 && stack[stack.length - 1].depth >= line.depth) stack.pop();
    const node = makeNode(line.text);
    stack[stack.length - 1].node.children.push(node);
    stack.push({ depth: line.depth, node });
  }
  return { root };
}

export function mindmapToOutline(node: MindNode, depth = 0): string {
  const lines = [`${"  ".repeat(depth)}- ${node.text}`];
  for (const child of node.children || []) lines.push(mindmapToOutline(child, depth + 1));
  return lines.join("\n");
}

/**
 * 思维导图 → 缩进列表的每一行。
 * 导出 Markdown 与「注入 Issue 上下文」共用这一份：别让下游去啃嵌套 JSON。
 * 与 mindmapToOutline 的差别只在空节点补一个占位符 —— 那两处都是给人/agent 读的正文。
 */
export function mindmapOutlineLines(node: MindNode, depth = 0): string[] {
  const lines = [`${"  ".repeat(depth)}- ${node.text || "(空)"}`];
  for (const child of node.children || []) lines.push(...mindmapOutlineLines(child, depth + 1));
  return lines;
}
