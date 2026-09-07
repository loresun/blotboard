"use client";

/**
 * 通用右键菜单：卡片 / 连线 / 空白各自给一份 items，渲染与定位在这里统一。
 * 自动避让窗口边缘；Esc、点外面、滚动都会关闭。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ICON_SM, UI, type LucideIcon } from "@/lib/icons";
import { COLORS } from "@/lib/constants";
import type { DictKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";
import type { AlignAction } from "@/lib/layout";
import type { CardColor } from "@/lib/types";

export interface MenuItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  /** 分隔线（只需 key 与 separator） */
  separator?: boolean;
  /** 颜色选择行 */
  colors?: { value: CardColor; onSelect: (color: CardColor) => void };
  /** 对齐 / 等距一行按钮 */
  aligns?: { onSelect: (action: AlignAction) => void };
  /** 二级菜单：一级只占一行，展开才列具体项——分组这类长列表用它，别把菜单撑到满屏 */
  submenu?: MenuItem[];
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** 对齐按钮的小图形：用 SVG 直接画比找图标更能一眼看懂对的是哪条边 */
const ALIGN_BUTTONS: [AlignAction, DictKey, React.ReactNode][] = [
  ["left", "canvas.align.left", alignGlyph("v", 2)],
  ["hcenter", "canvas.align.hcenter", alignGlyph("v", 8)],
  ["right", "canvas.align.right", alignGlyph("v", 14)],
  ["hspace", "canvas.align.hspace", spaceGlyph("h")],
  ["top", "canvas.align.top", alignGlyph("h", 2)],
  ["vcenter", "canvas.align.vcenter", alignGlyph("h", 8)],
  ["bottom", "canvas.align.bottom", alignGlyph("h", 14)],
  ["vspace", "canvas.align.vspace", spaceGlyph("v")],
];

function alignGlyph(line: "v" | "h", at: number): React.ReactNode {
  const vertical = line === "v";
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      {vertical ? (
        <>
          <line x1={at} y1="1" x2={at} y2="15" stroke="currentColor" strokeWidth="1.4" />
          <rect x={at === 14 ? 4 : at} y="3" width="10" height="3.4" rx="1" fill="currentColor" opacity="0.55" />
          <rect x={at === 14 ? 8 : at} y="9" width="6" height="3.4" rx="1" fill="currentColor" opacity="0.55" />
        </>
      ) : (
        <>
          <line x1="1" y1={at} x2="15" y2={at} stroke="currentColor" strokeWidth="1.4" />
          <rect x="3" y={at === 14 ? 4 : at} width="3.4" height="10" rx="1" fill="currentColor" opacity="0.55" />
          <rect x="9" y={at === 14 ? 8 : at} width="3.4" height="6" rx="1" fill="currentColor" opacity="0.55" />
        </>
      )}
    </svg>
  );
}

function spaceGlyph(dir: "h" | "v"): React.ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      {dir === "h" ? (
        <>
          <rect x="1" y="4" width="3" height="8" rx="1" fill="currentColor" opacity="0.55" />
          <rect x="6.5" y="4" width="3" height="8" rx="1" fill="currentColor" opacity="0.55" />
          <rect x="12" y="4" width="3" height="8" rx="1" fill="currentColor" opacity="0.55" />
        </>
      ) : (
        <>
          <rect x="4" y="1" width="8" height="3" rx="1" fill="currentColor" opacity="0.55" />
          <rect x="4" y="6.5" width="8" height="3" rx="1" fill="currentColor" opacity="0.55" />
          <rect x="4" y="12" width="8" height="3" rx="1" fill="currentColor" opacity="0.55" />
        </>
      )}
    </svg>
  );
}

export function ContextMenu({ state, onClose }: { state: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!state || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const left = Math.min(state.x, window.innerWidth - rect.width - 8);
    const top = Math.min(state.y, window.innerHeight - rect.height - 8);
    setPosition({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // pointerdown 捕获阶段：点到菜单以外任何地方都关
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [state, onClose]);

  if (!state) return null;

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {state.items.map((item) => (
        <MenuRow key={item.key} item={item} onClose={onClose} />
      ))}
    </div>
  );
}

/** 一行菜单项：分隔线 / 颜色行 / 对齐行 / 二级入口 / 普通项，五种长相都在这儿分流 */
function MenuRow({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const t = useT();
  if (item.separator) return <div className="cm-sep" />;
  if (item.colors) {
    return (
      <div className="cm-colors">
        <span className="cm-colors-label">{t("canvas.menu.color")}</span>
        {(Object.entries(COLORS) as [CardColor, string][]).map(([key, hex]) => (
          <button
            key={key}
            type="button"
            className={`swatch${item.colors!.value === key ? " active" : ""}`}
            style={{ background: hex }}
            title={key}
            onClick={() => {
              item.colors!.onSelect(key);
              onClose();
            }}
          />
        ))}
      </div>
    );
  }
  if (item.aligns) {
    return (
      <div className="cm-aligns">
        <span className="cm-colors-label">{t("canvas.menu.align")}</span>
        {ALIGN_BUTTONS.map(([action, label, glyph]) => (
          <button
            key={action}
            type="button"
            className="align-btn"
            title={t(label)}
            onClick={() => {
              item.aligns!.onSelect(action);
              onClose();
            }}
          >
            {glyph}
          </button>
        ))}
      </div>
    );
  }
  if (item.submenu?.length) return <SubmenuRow item={item} onClose={onClose} />;
  const Icon = item.icon;
  return (
    <button
      type="button"
      className={`cm-item${item.danger ? " danger" : ""}`}
      disabled={item.disabled}
      onClick={() => {
        item.onSelect?.();
        onClose();
      }}
    >
      {Icon ? <Icon {...ICON_SM} /> : <span className="cm-icon-space" />}
      <span className="cm-label">{item.label}</span>
      {item.hint ? <span className="cm-hint">{item.hint}</span> : null}
    </button>
  );
}

/**
 * 二级入口：一级只留一行，鼠标停上去（或点一下）才把子项摊开在右侧。
 * 子项默认贴右展开，右边放不下就翻到左边；上下也按窗口高度夹一夹，长列表自己滚。
 */
function SubmenuRow({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const subRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 鼠标正停在这一行上：点一下应该保持展开；触屏没有 hover，点一下才是开关 */
  const hovering = useRef(false);
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setOffset(null);
      return;
    }
    const anchor = wrapRef.current?.getBoundingClientRect();
    const sub = subRef.current?.getBoundingClientRect();
    if (!anchor || !sub) return;
    // 贴右边展开；右边不够就翻到左边
    const left = anchor.right + GAP + sub.width > window.innerWidth - 8 ? -sub.width - GAP : anchor.width + GAP;
    // 首项与父项对齐（减掉菜单自身 padding），下面装不下就整体往上顶
    let top = -MENU_PAD;
    const bottomOver = anchor.top + top + sub.height - (window.innerHeight - 8);
    if (bottomOver > 0) top -= bottomOver;
    if (anchor.top + top < 8) top = 8 - anchor.top;
    setOffset({ left, top });
  }, [open]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function cancelClose() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }
  // 从父项挪到子菜单要跨过那 2px 缝，留一小段宽限期再收
  function scheduleClose() {
    cancelClose();
    timer.current = setTimeout(() => setOpen(false), 140);
  }

  const Icon = item.icon;
  return (
    <div
      ref={wrapRef}
      className={`cm-sub-wrap${open ? " open" : ""}`}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        hovering.current = true;
        cancelClose();
        setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        hovering.current = false;
        scheduleClose();
      }}
    >
      <button
        type="button"
        className={`cm-item has-sub${item.danger ? " danger" : ""}`}
        disabled={item.disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        // 鼠标：已经 hover 展开了，点一下别把它点没；触屏 / 键盘：点一下就是开关
        onClick={() => setOpen((was) => (hovering.current ? true : !was))}
      >
        {Icon ? <Icon {...ICON_SM} /> : <span className="cm-icon-space" />}
        <span className="cm-label">{item.label}</span>
        {item.hint ? <span className="cm-hint">{item.hint}</span> : null}
        <UI.next {...ICON_SM} className="cm-sub-caret" />
      </button>
      {open ? (
        <div
          ref={subRef}
          className="context-menu cm-sub"
          role="menu"
          // 量完之前先藏着，免得先在错位置闪一下
          style={offset ? { left: offset.left, top: offset.top } : { left: 0, top: 0, visibility: "hidden" }}
        >
          {item.submenu!.map((child) => (
            <MenuRow key={child.key} item={child} onClose={onClose} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 子菜单与父菜单之间的缝 / 菜单自身内边距：跟 globals.css 里的 .context-menu 对齐 */
const GAP = 2;
const MENU_PAD = 5;

export const MENU_ICONS = UI;
