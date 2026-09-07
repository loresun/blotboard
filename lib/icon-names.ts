/** 自定义 agent 指令可选的图标名（服务端校验用，不引 lucide 本体）。 */
export const AGENT_ICON_NAMES = [
  "sparkles",
  "wand",
  "target",
  "clipboard",
  "network",
  "layers",
  "lightbulb",
  "flag",
  "blocks",
  "send",
  "run",
  "check",
] as const;

export type AgentIconName = (typeof AGENT_ICON_NAMES)[number];

/** 模板可选的图标名（服务端校验模板 json 用，不引 lucide 本体；映射见 lib/icons.tsx） */
export const TEMPLATE_ICON_NAMES = [
  "grid",
  "shuffle",
  "hexagon",
  "compass",
  "telescope",
  "atom",
  "repeat",
  "circle",
  "scale",
  "stethoscope",
  "calendar",
  "route",
  "book",
  "boxes",
  "target",
  "milestone",
  "split",
  "waypoints",
  "recycle",
  "branch",
] as const;

export type TemplateIconName = (typeof TEMPLATE_ICON_NAMES)[number];

/** 卡片规格可选的图标名（服务端校验规格 json 用，不引 lucide 本体；映射见 lib/icons.tsx） */
export const SPEC_ICON_NAMES = [
  "message",
  "doc",
  "article",
  "code",
  "branch",
  "user",
  "chart",
  "money",
  "calendar",
  "clipboard",
  "package",
  "bug",
  "bell",
  "scale",
  "target",
  "boxes",
  "flag",
  "link",
] as const;

export type SpecIconName = (typeof SPEC_ICON_NAMES)[number];
