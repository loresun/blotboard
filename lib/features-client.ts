"use client";

/**
 * 功能开关的前端读法：真源在服务端（lib/features.ts），经 `<body data-features>`
 * 与 `<body data-task-backend>` 下发。
 *
 * 为什么用 useSyncExternalStore 而不是渲染时直接摸 document：
 * 客户端组件在服务端也要先渲染一遍，那时没有 document——直接摸会 hydration 不一致。
 * 这里让服务端快照恒为「全关 + local 后端」，水合后立刻读到真实值，React 自己会补一次渲染。
 * dataset 在页面生命周期内不会变，所以 subscribe 是个空订阅。
 */
import { useSyncExternalStore } from "react";
import { browserStorageActive, browserWorkspace } from "./storage-mode";

export type TaskBackendKind = "goal-agent" | "local" | "http";

export interface ClientFeatures {
  tasks: boolean;
  search: boolean;
  library: boolean;
  /** 任务后端种类：入口文案与形态跟着它换（local 下「发起任务」= 生成 prompt） */
  taskBackend: TaskBackendKind;
  browserStorage: boolean;
}

const subscribe = () => () => {};
// 两个 dataset 键并成一个快照串：useSyncExternalStore 的 getSnapshot 必须返回稳定的原始值
const readDataset = () => `${document.body.dataset.features ?? ""}|${document.body.dataset.taskBackend ?? ""}|${browserStorageActive() ? "browser" : "server"}|${browserWorkspace()}`;
const serverSnapshot = () => "||server|default";

function parseBackend(raw: string): TaskBackendKind {
  return raw === "goal-agent" || raw === "http" ? raw : "local";
}

function parse(raw: string): ClientFeatures {
  const [features = "", backend = "", storage = "server"] = raw.split("|");
  const names = new Set(features.split(",").filter(Boolean));
  const local = storage === "browser";
  return {
    tasks: !local && names.has("tasks"),
    search: !local && names.has("search"),
    library: !local && names.has("library"),
    taskBackend: local ? "local" : parseBackend(backend),
    browserStorage: local,
  };
}

/** 渲染期用这个（入口按钮显隐 / 文案切换）。 */
export function useFeatures(): ClientFeatures {
  return parse(useSyncExternalStore(subscribe, readDataset, serverSnapshot));
}

/** 事件回调 / 非组件代码用这个（那时一定有 document）。 */
export function featureOn(name: "tasks" | "search" | "library"): boolean {
  if (typeof document === "undefined") return false;
  return parse(readDataset())[name];
}

/** 事件回调里判断任务后端种类（local 下发起任务不弹 implement/analyze 的确认框）。 */
export function taskBackendKind(): TaskBackendKind {
  if (typeof document === "undefined") return "local";
  return parseBackend(document.body.dataset.taskBackend ?? "");
}
