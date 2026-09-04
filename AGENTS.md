# Bottega

A workshop. One designer holds the whole picture, several hands build to that
design, and nothing ships the designer has not read and signed.

The name is Verrocchio's: assistants executed to the master's drawing and the
master put their name to the result. It is not decoration — it is the division
this codebase enforces. `orchestrator/` delegates implementation to external
agents under a contract that forbids them to decide anything; a worker that
reaches a judgement call stops and asks, and the architect rules, reads the
diff, and judges it on whether it built what it was asked to build.

It was called `devbox`, which described a scratch directory for one machine's
odds and ends. That is what it was.

Several concerns live here side by side because they share a machine, not
because they share a purpose. **The name is written once, in
`shared/brand.ts`**, and `check-brand` fails the build if it appears anywhere
else in code — a brand module nobody is obliged to use collects leaked literals
until the rename it existed to make cheap is a hunt through twenty files.

## The concerns, and the line between them

| | what it is |
|---|---|
| `orchestrator/` | Delegate work to external agents, score them per job type, and route the next job by what scored well. Has its own canon. |
| `ops/` | The machine itself: the morning refresh, launchd agents, brew upkeep. |
| `hub/` | Every project's work in one view: what is in flight, what each task cost, and the daily report. Has its own canon. |
| `local-stack/` | Serving models locally, and the local model host. |
| `shared/` | The only code any two concerns may both import. |

Cross-project porting used to be its own concern at `port/`. The directory
is gone. The ledger, pairs, baselines, skips and doctrine now live in
`orch.db` and are reached through `orch port` and the MCP tools.

**They do not reach into each other.** A concern imports from itself or from
`shared/`, and `shared/` imports from nobody. `bun run check` enforces it,
because a boundary nobody checks has already drifted — the same reason a sibling project
holds its kernel/context floor with a script rather than a rule.

Three more separations that matter as much as the import graph:

- **A database per concern.** `orchestrator/orch.db` is its own. A shared
  database is how two concerns quietly become one.
- **A binary per concern**, in `bin/`. `orch` does one thing.
- **Canon per concern.** Each directory carries its own `AGENTS.md`; a session
  working in `ops/` is not handed the orchestrator's rules.

## Secrets

**No concern here stores a secret.** MCP tokens live in `~/.claude/.env`, the
SMTP password in the login keychain, and `hub`'s settings hold a *reference*
(`keychain:work-report-smtp`) which the dashboard reports only as resolving or
not. Read them at use time; never at import, never into a log, never into a
database the dashboard serves from.

The metered Anthropic key that used to sit in `work-report/config.json` is gone
with it. Summaries go through `orch`, which spends neither metered billing nor
the Claude allotment — the one cost the orchestrator exists to avoid.

So is the directory. `1b07f45` retired the concern but left 224K of Python, its
logs and a still-tracked `config.json` on disk — a seventh concern that the table
above does not list and `bun run check` does not police, which is how a retired
thing goes on quietly being part of the repo. Its 22 files are recoverable from
`1b07f45^` if they are ever wanted.

## This machine

**One checkout per project.** Numbered clones are gone. Parallel work happens in
git worktrees under each repo's `.claude/worktrees` — one project routinely
carries a dozen or more.

**Nothing here refreshes a worktree.** A worktree belongs to one task and one
session; a scheduled job mutating them behind the author's back would destroy
more than it fixed. `ops/` refreshes main checkouts only.

**After cloning:** `git config core.hooksPath .githooks`. The commit-msg hook there refuses AI attribution in commit messages; the matching Claude Code hook lives in `orchestrator/hooks/no-attribution.py`.

## Tasks

Work here is tracked in `hub`, and every task carries a `DEV-` key:
`./bin/hub task list --project bottega`, `hub task new --project bottega --title "..."`.
Branches and commit subjects cite the key, and `orch do` requires `--key`; work naming
no key is recorded against the project with no task and the link cannot be recovered.

**The project register is the authority** on key prefixes, worktree recipes and
per-project notes — `orch project list --json`. Read it before concluding a project
lacks something.
