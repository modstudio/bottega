# Bottega

Bottega is the orchestration workshop for every project on this machine. The
architect designs and rules; implementation workers execute without making
product decisions; the architect reads and judges every result. The frontier
harness is replaceable, while Bottega supplies agent management and the
lifecycle beneath it.

## Concerns stay separate

The repository contains these independent concerns:

- `orchestrator/` delegates work, records evidence, scores results and routes jobs.
- `hub/` presents project work, task cost and reports.
- `ops/` maintains the machine.
- `local-stack/` serves local models.
- `shared/` is the only code that multiple concerns may import.

A concern imports only itself or `shared/`, and `shared/` imports from nobody.
Each concern owns its local store, binary and canon. The hosted record is one
Postgres schema in `shared/record`, and each concern writes only its own tables
through its own services. `scripts/check-architecture.ts` enforces the import
boundary from `architecture.ts`.

The product name lives only in `shared/brand.ts`; `bun run check` enforces that
code does not duplicate it.

## Bottega serves the other projects

Workflow and lifecycle capability belongs here and is exposed through `orch`,
the MCP surface and the project register. Do not copy a Bottega mechanism into
a project when that project can call Bottega. Worktree scripts remain project
owned because the register's create recipe is their interface.

A project may keep its own task tracker, doc store, workflows or review
pipeline. The project register, read with `orch project list --json`, is the
authority on which concerns it keeps, its key prefixes, landing branch,
worktree recipes and project notes. Read it before assuming which system
applies or that a project lacks a capability. Pull requests target the declared
landing branch, never an optional production branch.

## Secrets

No concern stores a secret. What is stored is a reference to where the secret
lives, written as `keychain:<service>` or `env:<NAME>` and never the secret
itself; `hub/src/settings.ts` refuses a password in that field. Read a
credential from its owner at use time, never at import, and never write it to a
log or to a database the dashboard serves. Only whether a reference resolves
may be reported. Gitleaks gates the repository, and its allowlist is limited to
named fake fixture credentials in `.gitleaks.toml`.

Summaries go through `orch`; do not add a metered provider key for them.

## This machine

Keep one checkout per project. Parallel work belongs in disposable git
worktrees under the project's `.claude/worktrees/`. Nothing refreshes a
worktree behind its owner; `ops/` refreshes main checkouts only.

After cloning, configure the tracked hooks with `git config core.hooksPath
.githooks`. The hooks refuse AI attribution in commit messages; the harness
counterpart is `orchestrator/hooks/no-attribution.py`.

Landing goes through the private `origin` by pull request. Push the branch,
open the pull request, run its checks and merge on GitHub. Trunk moves remotely;
the local checkout follows it. Never fast-forward local trunk and call that
landed, and do not invent a local admission queue.

The pull-request rule is procedural rather than mechanically protected. Follow
it regardless, and buy enforcement only after an observed violation.

Run the local gate before opening the pull request. The local gate proves the
commit; the remote process admits it. A check that skips what it cannot
provision is informational, not a gate, because running nothing proves
nothing. Attribute each failure before aggregating it; an unattributed count
is not a rate.

## Tasks

Work in progress is tracked in `hub`, and every task, branch and commit subject
carries its project task key. Use `hub task` to manage tasks. Work without a key
cannot later be attributed to its task. `orch do` requires the key.

The project register is authoritative for task-key prefixes and worktree
recipes. Its project update verbs verify declared branches and refuse a
mismatch; `orch doctor` reports a checkout on the wrong branch as a register
question rather than a run failure.

## Canon

Canon has four tiers. This entry and `.agents/rules/` are always on; context
files are path-scoped; a directory `AGENTS.md` is its folder card; demand
references live in the doc store. Canon rows use doc-store scope
`canon` and reach the tree through `orch canon hydrate`. Research and plans
live in the doc store, not always-on files.

Edit canon in the store, never in the tree. Change the row with `orch doc
set` at scope `canon`, sync it into your worktree with `orch canon hydrate`,
then commit the files hydrate wrote. A canon file edited by hand is
overwritten at the next hydrate and never becomes canon.

Every `AGENTS.md` has a sibling `CLAUDE.md` symlink. `.claude/rules` exposes the
always-on rules. `orch canon lint` gates tier budgets, metadata, writing rules
and citations.
