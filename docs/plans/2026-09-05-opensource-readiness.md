# Open-source readiness implementation plan

**Goal:** Deliver a verifiable local-first Blotboard release with generic optional integrations, safe Agent onboarding, precise layout, and reliable build/deployment behavior.

**Architecture:** Preserve the headless core, static card packs, and shared rendering services. Agent onboarding consumes the deployment-generated `/api/skill`; copied board prompts contain links and identifiers but never credentials. Keep personal deployment settings and user boards outside the distributable source. Retain local-first trust boundaries and document commercial deployment limits explicitly.

**Tech Stack:** Next.js, TypeScript, React Flow, Node.js, Playwright.

## Baseline and collaboration

Work in `codex/opensource-readiness`, isolated from the live checkout. The initial working state includes existing uncommitted features; retain them and validate them together. Check the original checkout against the captured baseline before integrating any files. Never copy real data, credentials, or local process configuration into the review workspace. All tests use isolated temporary data. Only the coordinator commits or runs the full build/check pipeline.

## 1. Precise geometry and neighbor snapping

Review `lib/layout.ts`, `lib/align-snap.ts`, `components/AlignGuides.tsx`, `components/BoardCanvas.tsx`, and geometry constants. Verify edge/center alignment and exact spacing for mixed dimensions, common grid size, zoom-scaled threshold, multi-selection, frame coordinates/followers, locked/hidden cards, drag termination, and resize behavior. Add independent numerical and browser regression cases, reproduce failures, then fix the smallest responsible layer.

## 2. Agent entry points

Review `lib/skill.ts`, `lib/skill-core.md`, the MCP CLI, site navigation, board context menus, and existing Agent UI. Add a shared board handoff prompt builder; expose copy actions with accurate success/failure feedback. Add `/agent` to site navigation with deployment-specific instructions and copyable Skill install prompts/commands. Derive URLs from the actual deployment, preserve proxy trust rules, never include tokens or private filesystem paths, and explain reachability for remote agents. Test clipboard output, IDs, installation paths, API contracts, and unconfigured deployments.

## 3. Security and open-source audit

Review API authentication, upload/preview paths, exported HTML/Markdown/SVG handling, URL fetchers, input bounds, storage/checkpoint contracts, and ACP settings exposure. Reproduce actionable findings and add regressions. Audit tracked source and distributable assets for private deployment assumptions. Optional integrations must have generic documented contracts, safe empty defaults, and no dependency on the author's running services. Preserve external Runner request compatibility.

## 4. Build, release, and maintenance

Inspect dependency audit, license, CI, package contents, Git history exposure, deployment instructions and static-resource diagnostics. Prevent the previously reproduced build/server mismatch through a documented safe release path and focused checks. Keep production rebuilds away from the live checkout until ready for a controlled restart. Add release checks that expose private artifacts without printing secrets.

## 5. Acceptance and integration

Run `npm ci`, then `npm run check` (lint:repo, typecheck, build, smoke, e2e), fixing failures without weakening tests. Validate a clean default deployment and browser onboarding/copy actions. Review all diffs, record material remaining limits in an audit report, and create precise commits after checks pass. Reconcile the original checkout without overwriting concurrent work. For the live service, preserve its private integration configuration, deploy the validated build coherently, restart only Blotboard, and verify PID/cwd/health, current JS/CSS responses, and browser rendering. Do not claim Internet-facing multi-tenant certification from local-first testing.
