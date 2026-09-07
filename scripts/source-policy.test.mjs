import test from "node:test";
import assert from "node:assert/strict";
import { sourcePathAllowed, publicExampleHost } from "./source-policy.mjs";

test("release includes code and shipped templates, never personal deployment data", () => {
  for (const file of ["app/page.tsx", "data/templates/example.json", "data/card-specs/prompt.json", "docs/guide/agent.md", "docs/guide/en/agent.md", "ecosystem.config.example.cjs", "LICENSE", "README.en.md"]) assert.equal(sourcePathAllowed(file), true, file);
  for (const file of ["data/token", "data/boards/private.json", "data/uploads/a.png", "data/runner-settings.json", "data/checkpoints/a.json", ".env", ".env.production", "ecosystem.config.cjs", "scripts/lint-repo.local.json", ".git/config", ".next/BUILD_ID", ".blotboard-runtime/server-1.json", "private-notes/file.md", "public/excalidraw-assets/font.woff", "docs/../../data/token", "llms.txt", "notes.local.md"]) assert.equal(sourcePathAllowed(file), false, file);
});

test("release host policy rejects unknown domains and personal network IPs", () => {
  assert.equal(publicExampleHost("docs.example.com"), true);
  assert.equal(publicExampleHost("github.com"), true);
  assert.equal(publicExampleHost("private-deployment.com"), false);
  assert.equal(publicExampleHost("192.168.4.42"), false);
  assert.equal(publicExampleHost("github.com.attacker.com"), false);
  assert.equal(sourcePathAllowed(".env.example"), true);
  for (const file of ["docs/customer-export.csv", "public/customer-backup.sqlite", "docs/private-backup.zip", "public/private-photo.png"]) assert.equal(sourcePathAllowed(file), false, file);
});
