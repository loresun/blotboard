"use client";

import { useEffect, useRef } from "react";
import { ControlButton } from "@xyflow/react";
import { boardKeyBlocked } from "@/lib/keyboard-shortcuts";
import { useBoardStore } from "@/lib/store";
import { useT } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import styles from "./KeyboardHelp.module.css";

/** 左边键位、右边说明，两列都走字典——「按住空格」这种键位本身也是要翻的话 */
const shortcuts: [DictKey, DictKey][] = [
  ["pages.shortcuts.keys.undo", "pages.shortcuts.undo"],
  ["pages.shortcuts.keys.redo", "pages.shortcuts.redo"],
  ["pages.shortcuts.keys.selectAll", "pages.shortcuts.selectAll"],
  ["pages.shortcuts.keys.copyPaste", "pages.shortcuts.copyPaste"],
  ["pages.shortcuts.keys.delete", "pages.shortcuts.delete"],
  ["pages.shortcuts.keys.find", "pages.shortcuts.find"],
  ["pages.shortcuts.keys.zoom", "pages.shortcuts.zoom"],
  ["pages.shortcuts.keys.tools", "pages.shortcuts.tools"],
  ["pages.shortcuts.keys.readComment", "pages.shortcuts.readComment"],
  ["pages.shortcuts.keys.escape", "pages.shortcuts.escape"],
  ["pages.shortcuts.keys.help", "pages.shortcuts.help"],
];

export function KeyboardHelp() {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.ctrlKey || event.metaKey || event.repeat || boardKeyBlocked(event, useBoardStore.getState())) return;
      event.preventDefault();
      dialog.current?.showModal();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return <>
    <ControlButton title={t("pages.shortcuts.open")} aria-label={t("pages.shortcuts.title")} onClick={() => dialog.current?.showModal()}>?</ControlButton>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="board-shortcuts-title">
      <div className={styles.heading}>
        <h2 id="board-shortcuts-title">{t("pages.shortcuts.title")}</h2>
        <button type="button" aria-label={t("pages.shortcuts.close")} onClick={() => dialog.current?.close()}>{t("common.close")}</button>
      </div>
      <p>{t("pages.shortcuts.modifierNote")}</p>
      <table><tbody>{shortcuts.map(([keys, action]) => <tr key={keys}><th><kbd>{t(keys)}</kbd></th><td>{t(action)}</td></tr>)}</tbody></table>
      <p>{t("pages.shortcuts.footNote")}</p>
      <a href="/docs?doc=shortcuts" target="_blank" rel="noreferrer">{t("pages.shortcuts.more")}</a>
    </dialog>
  </>;
}
