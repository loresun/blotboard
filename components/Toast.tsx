"use client";

import { useEffect, useState } from "react";
import { useBoardStore } from "@/lib/store";

/** 轻提示；带 action 时多给一个按钮（整理布局的「撤销」就走这里）。 */
export function Toast() {
  const toast = useBoardStore((state) => state.toast);
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);

  useEffect(() => {
    if (!toast) return;
    setCurrent({ text: toast.text, action: toast.action });
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), toast.action ? 6000 : 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <div className={`toast${visible ? " show" : ""}`}>
      <span>{current?.text}</span>
      {current?.action ? (
        <button
          className="toast-action"
          onClick={() => {
            current.action?.run();
            setVisible(false);
          }}
        >
          {current.action.label}
        </button>
      ) : null}
    </div>
  );
}
