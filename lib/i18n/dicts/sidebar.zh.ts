/**
 * 「sidebar」这一摊的中文文案。中文是键的唯一来源，值必须与改造前逐字一致——
 * e2e 大量按可见文字取元素，这里改一个字会在别处炸。
 */
export const sidebarZh = {
  /* ── 左栏分段与新建 ─────────────────────── */
  "sidebar.tab.boards": "画板",
  "sidebar.tab.cards": "卡片",
  "sidebar.new.caret.title": "新建分组 / 在某个分组里新建",

  /* ── 画板搜索 ───────────────────────────── */
  "sidebar.search.placeholder": "搜画板名 / 分组 / 卡片内容",
  "sidebar.search.clear": "清除（Esc）",
  "sidebar.search.empty": "没有名字或分组匹配的画板",

  /* ── 画板树 ─────────────────────────────── */
  "sidebar.board.row.title": "右键：复制 Agent 提示词 / 移动到分组 / 复制 ID",
  "sidebar.board.unfold": "展开子画板",
  "sidebar.board.fold": "折叠子画板",
  /** 行尾计数的 tooltip；有待处理评论时后面再接一段 counts.comments */
  "sidebar.board.counts": "{cards} 张卡片 · {tasks} 个任务",
  "sidebar.board.counts.comments": "{count} 条待处理评论",
  /** 行尾那枚窄徽章，一屏几十行都要塞得下，所以是缩写不是整句 */
  "sidebar.board.meta.cards": "{count}卡",
  "sidebar.board.meta.tasks": "/{count}务",
  "sidebar.board.meta.comments": "{count}评",
  "sidebar.board.more": "更多：移动到分组 / 复制 ID / 删除",
  "sidebar.locate": "滚回当前画板",

  /* ── 分组 ───────────────────────────────── */
  "sidebar.group.none": "未分组",
  "sidebar.group.current.title": "当前画板就在这个分组里",
  "sidebar.group.current": "当前",
  "sidebar.group.more": "分组：重命名 / 解散",
  "sidebar.group.rename": "重命名分组",
  "sidebar.group.rename.hint": "{count} 块画板",
  "sidebar.group.prompt": "分组（项目）名称",
  "sidebar.group.renamed": "分组已改名为「{name}」",
  "sidebar.group.newBoard": "在这个分组里新建画板",
  "sidebar.group.dissolve": "解散分组",
  "sidebar.group.dissolve.hint": "画板保留",
  "sidebar.group.dissolve.confirm": "解散分组「{group}」？里面的 {count} 块画板会移到「未分组」，画板本身不删。",
  "sidebar.group.dissolved": "分组已解散",

  /* ── 新建菜单 ───────────────────────────── */
  "sidebar.new.board": "新建画板",
  "sidebar.new.inGroup": "在「{group}」里新建",
  "sidebar.new.inGroups": "在分组里新建",
  "sidebar.new.inGroups.hint": "{count} 个分组",
  "sidebar.new.group": "新建分组…",
  "sidebar.new.group.hint": "并建一块板",
  "sidebar.new.group.prompt": "新分组（项目）名称",

  /* ── 画板右键菜单 ───────────────────────── */
  "sidebar.board.open": "打开这块画板",
  "sidebar.board.copyAgentCdp": "复制 CDP Agent 提示词",
  "sidebar.board.copyAgent": "复制给 Agent 的提示词",
  "sidebar.board.copyId": "复制画板 ID",
  "sidebar.board.copyName": "复制画板名称",
  "sidebar.board.copyApi": "复制 API 地址",
  "sidebar.board.copyCurl": "复制 curl 片段",
  "sidebar.board.delete": "删除画板",
  "sidebar.board.delete.confirm": "删除画板「{name}」？其中的卡片与连线将一并删除。",
  "sidebar.board.deleted": "画板已删除",

  /* ── 移动到分组 ─────────────────────────── */
  "sidebar.move": "移动到",
  "sidebar.move.newGroup": "新分组…",
  "sidebar.move.clear": "移出分组",
  "sidebar.move.unnest": "提为顶层画板",
  "sidebar.moveTo": "已移到「{group}」",
  "sidebar.move.cleared": "已移出分组",

  /* ── 复制反馈 ───────────────────────────── */
  "sidebar.copy.done": "{label}已复制",
  "sidebar.copy.failed": "复制失败，请打开 Agent 页面手动复制",
  "sidebar.copy.label.cdpPrompt": "CDP 提示词",
  "sidebar.copy.label.boardPrompt": "画板提示词",
  "sidebar.copy.label.boardId": "画板 ID",
  "sidebar.copy.label.boardName": "画板名称",
  "sidebar.copy.label.api": "API 地址",
  "sidebar.copy.label.curl": "curl 片段",
  "sidebar.copy.label.cardId": "卡片 ID",
  "sidebar.copy.label.title": "标题",
  "sidebar.copy.label.cardApi": "卡片 API 地址",

  /* ── 深度搜索结果 ───────────────────────── */
  "sidebar.deep.head": "卡片内容命中",
  "sidebar.deep.loading": "搜索中…",
  "sidebar.deep.empty": "卡片内容里没有「{keyword}」",
  "sidebar.deep.card.title": "点击打开画板并定位到这张卡",
  "sidebar.deep.more": "还有 {count} 张命中，打开画板后用 ⌘F 继续找",

  /* ── 卡片段 ─────────────────────────────── */
  "sidebar.cards.emptyFiltered": "没有命中筛选的卡片",
  "sidebar.cards.empty": "这块画板还没有卡片",
  "sidebar.card.untitled": "{label}卡片",
  "sidebar.card.item.title": "点击定位；右键复制 ID",

  /* ── 卡片右键菜单 ───────────────────────── */
  "sidebar.card.focus": "在画布上定位",
  "sidebar.card.edit": "编辑内容",
  "sidebar.card.copyId": "复制卡片 ID",
  "sidebar.card.copyTitle": "复制标题",
  "sidebar.card.copyApi": "复制卡片 API 地址",
  "sidebar.card.delete": "删除卡片",

  /* ── 底部速查 ───────────────────────────── */
  /** 这四行与 <kbd> 交错排版，键之间的空格由 JSX 出，值里不带首尾半角空格 */
  "sidebar.foot.select": "选择 /",
  "sidebar.foot.pan": "抓手　按住",
  "sidebar.foot.space": "空格",
  "sidebar.foot.panTemp": "临时平移",
  "sidebar.foot.marquee": "选择模式左键拖 · 框选　",
  "sidebar.foot.selectAll": "A 全选　",
  "sidebar.foot.delete": "删除选中",
  "sidebar.foot.wheel": "滚轮/双指 · 平移　",
  "sidebar.foot.zoom": "+滚轮 · 缩放　",
  "sidebar.foot.search": "F 搜索",
  "sidebar.foot.mouse": "双击空白 · 新建卡片　双击卡片 · 编辑　右键 · 更多操作",

  /* ── 宽度把手 ───────────────────────────── */
  "sidebar.resizer.title": "拖动调整左栏宽度（双击恢复默认）",

  /* ── 工具条：建卡与更多 ─────────────────── */
  "toolbar.fab.title": "展开工具栏（建卡 / 搜索 / 筛选）",
  "toolbar.fab": "工具",
  "toolbar.fab.filter": "筛选生效中",
  "toolbar.fab.focus": "聚焦模式开着",
  "toolbar.more": "更多",
  "toolbar.more.title": "更多卡片：结构化与组织用的（规格卡 / 子画板 / 分组框 / 网页），以及要配外部服务的来源卡",
  "toolbar.more.structure": "组织与结构化",
  "toolbar.more.external": "外部来源",
  "toolbar.upload": "上传",
  "toolbar.upload.title": "上传图片 / PDF（也可拖入或粘贴）",
  "toolbar.subboard.name": "子画板",
  "toolbar.toast.needBoard": "先新建或选择一块画板",

  /* ── 工具条：换个看法的几个开关 ─────────── */
  "toolbar.outline": "大纲",
  "toolbar.focus": "聚焦",
  "toolbar.align": "对齐",
  "toolbar.grid": "网格",
  "toolbar.nodebar": "快捷条",
  "toolbar.collapse.title": "收起工具栏（搜索/筛选保持生效）",
  "toolbar.collapse.aria": "收起工具栏",

  /* ── 工具条：悬停解释卡 ─────────────────── */
  "toolbar.help.on": "已开启",
  "toolbar.help.off": "已关闭",
  "toolbar.help.outline.title": "大纲 · 换一种读法",
  "toolbar.help.outline.body": "把当前画板按阅读顺序摊成一列，并按连线显示层级；不会改变卡片内容和画布位置。",
  "toolbar.help.focus.title": "聚焦 · 暂时降噪",
  "toolbar.help.focus.body": "选中一张卡后，只突出它和直接相连的卡片，其余卡片变淡；取消选择即可看回全板。",
  "toolbar.help.align.title": "对齐 · 跟邻居吸附",
  "toolbar.help.align.body": "拖动到附近卡片的边线、中线或等间距位置时自动贴齐；缩放时手上那条边同样会贴上邻居的边线与中线。都显示参考线，默认开启。",
  "toolbar.help.grid.title": "网格 · 跟点阵吸附",
  "toolbar.help.grid.body": "手动拖动或缩放时吸到 {size}px 点阵。它不会重排整板，也不保证与邻居对齐。",
  "toolbar.help.nodebar.title": "快捷条 · 常用动作浮上来",
  "toolbar.help.nodebar.body": "选中卡片时，在卡片上方显示改色、阅读、评论、复制和删除；关闭后，卡头 ⋯ 与右键菜单仍保留全部功能。",
  /* ── 导出 / 导入画板（画板包）───────────── */
  "sidebar.export.toast": "正在导出{label}（{kind}）",
  "sidebar.export.kind.bundle": "画板包",
  "sidebar.export.kind.html": "排版 HTML",
  "sidebar.export.failed": "导出失败：{message}",
  "sidebar.export.bundle": "画板包（.blotboard.json）",
  "sidebar.export.bundle.hint": "含附件",
  "sidebar.export.html": "排版 HTML",
  "sidebar.export.html.hint": "也能导回",
  "sidebar.export.board": "导出这块画板",
  "sidebar.export.board.hint": "含子画板",
  "sidebar.export.board.label": "「{name}」",
  "sidebar.export.group": "导出这个分组",
  "sidebar.export.group.hint": "{count} 块",
  "sidebar.export.group.label": "分组「{group}」",
  "sidebar.import": "导入画板…",
  "sidebar.import.hint": ".json / .html",
  "sidebar.import.done": "已导入 {imported} 块画板",
  "sidebar.import.skipped": "，跳过 {skipped} 块",
  "sidebar.import.failed": "导入失败：{message}",
} as const;
