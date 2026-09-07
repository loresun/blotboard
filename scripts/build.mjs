#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claimBuild } from "./build-guard.mjs";
import { ensureExcalidrawAssets } from "./sync-excalidraw-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const release = claimBuild(root);
  process.once("exit", release);
  ensureExcalidrawAssets();
  const nextBin = path.join(root, "node_modules/next/dist/bin/next");
  process.env.NODE_ENV = "production";
  process.chdir(root);
  process.argv = [process.execPath, nextBin, "build", ...process.argv.slice(2)];
  // Run the installed CLI in this process: the lock owner is the actual Next build,
  // never a wrapper that can die and leave an unprotected child building .next.
  await import(pathToFileURL(nextBin).href);
} catch (error) {
  console.error(`[blotboard] ${error.message}`);
  process.exitCode = 1;
}
