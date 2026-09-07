---
title: Spec cards and envelopes
summary: One JSON spec = one class of structured card; one envelope = the shipping format for a batch of cards
group: Take it with you & extend
order: 52
---

An ordinary card is "a title plus a body". Some things have fields by nature — meeting notes have a time and attendees, a content topic has a platform and a status, an incident writeup has a symptom and a root cause. **Spec cards** are for exactly those.

## What a spec is

A JSON spec describes one class of card: which fields it has, what type each field is (text / enum / date / number / tag), how the card's title is composed, and which fields are required. Install that spec and the board will:

- Generate a form from the fields in the editor, so you don't hand-write Markdown
- Lay the card face out per the spec
- Let Timeline and Kanban tidy recognize its date field and status field
- Emit a property table in the exported HTML

**Installing a spec takes no code changes** and no restart — it's just a piece of JSON.

## The 17 built-in specs

| Category | Which ones |
| --- | --- |
| External sources | Feishu message / Feishu doc / WeChat article / GitHub Issue or PR / tracked account / referenced resource |
| Records | Meeting notes / decision record / incident writeup / content topic / published piece / prompt / contact / local service |
| Insight | Metric snapshot / model benchmark / user feedback |

Look at their fields, their switches, and "create one from the example" under **Card** (the Card center) in the top bar.

## Envelopes: the shipping format for a batch of cards

An envelope is a piece of JSON shaped like this: a format marker, a version number, and a `cards` array in which each card carries `spec` (which spec) and `fields` (the field values).

It solves three problems:

- **Bulk landing** — an agent pushes in dozens of structured cards at once
- **Dry-run validation** — validate before writing anything, telling you card by card which is missing a required field and which has the wrong type, without writing a single byte
- **Deduplication** — a card carrying an `externalId` received a second time is an update, not an addition

The interface entry point is "**Ingest cards**" in the Card center: paste envelope JSON, validate, land it. On the agent side it's `POST /api/boards/{id}/ingest`.

## Lenient on receiving, strict on creating

Two deliberately asymmetric rules:

- **Strict on creating** — creating a card of a kind this machine doesn't have, or has disabled, is rejected with a 400
- **Lenient on receiving** — an envelope containing a kind this machine doesn't have **is accepted anyway**, displayed in a degraded form

Because an envelope is an exchange format, and the machine it came from may have card packs you don't. Accepting beats rejecting — the data is preserved, and installing the matching pack makes it display properly. The companion rule is the **pass-through law**: unrecognized fields are stored untouched and never scrubbed, and no "open board → save" cycle will destroy them.

## Writing your own spec

You can create a spec directly in the Card center, or paste one in as JSON. The format is documented in `docs/CARD-SPEC.md` in the repo; `GET /api/card-specs/schema` also returns a schema plus prompt you can feed straight to a model.

**Ask yourself first**: can the thing you want be expressed as a spec JSON? If it can, don't write code — specs are hot-pluggable, and code packs are reserved for cases that need custom rendering, a data source connection, or a server-side proxy.
