---
title: Resources
summary: A register of the things an agent can install and use straight away
group: Take it with you & extend
order: 53
---

You find a useful skill / MCP / CLI, jot it down on some board — and then nobody can ever find it again. Resources is the cure for that.

## What it is

One "**referenced resource**" spec card is one resource: name, kind (skill / MCP / CLI / library / template / service / dataset), what it's for, **how to install it**, how to use it, which agents it works with, its trigger words, and its status (verified / trying / to install / broken / deprecated).

These cards are scattered across boards, and the **Resources** page in the site nav lays out the whole deployment's worth on a single page: filter by kind and status, search by keyword, copy the install command in one click.

## Why it earns its own page

Because it has two readers:

- **People** — browse what this machine has accumulated, grab an install command
- **Agents** — hit `GET /api/resources` for **the same data**, with the same filter parameters

The two can never drift, because there is only ever one copy of the data. The deployment guide assembled by `/api/skill` carries this section too — an agent knows on arrival which ready-made tools this machine has.

## How to register something

Create a "referenced resource" spec card on any board and fill in the fields. It appears on the Resources page immediately.

The Resources page is **read-only**: registering and revising happen on the board (create a card, edit a card, hand off work by comment), and this page's only job is to show it clearly. That way there's no "two places can edit it, what happens when they disagree" problem.

## How to fill in the status

Honestly. `verified` is the only tier worth being proud of — it means you actually installed it and got it working. `to install` and `trying` are just as valuable: they tell you (and the agent) that this one can't be trusted yet. Don't delete `broken` ones — keeping them stops you walking into the same wall next time.
