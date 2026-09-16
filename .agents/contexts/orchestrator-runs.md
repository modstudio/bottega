---
description: Disposable runs, worktrees, locks, escalation, cleanup, and the test gate.
paths:
  - orchestrator/src/**
  - orchestrator/hooks/**
  - orchestrator/test/**
---

# Disposable runs

A repository job runs in its own throwaway worktree. Orch carries the caller's visible git state (committed, staged, unstaged, deletions, binaries, non-ignored untracked). Ignored runtime state is provisioned by the project's recipe, never copied from another checkout.

The worktree is the safety boundary. A repository agent gets workspace-write for that tree and its linked-worktree git metadata. A writing worker also gets the common object store and the directories holding its own run-branch ref and reflog. The ref guard permits only that exact branch. Never use `CODEX_EXEC_SANDBOX` for a repository run. Inline jobs (`summarize`, `review-lens-inline`) create no worktree.

**A registered main checkout stays clean.** Dispatch refreshes the main index and refuses tracked modifications, naming the dirty paths and the worktree (both anchored lines). Untracked files warn; ignored files are silent. Default on; opt out with `requireCleanMain` false. Resumes skip the check. Bare-main end state: `orch doc show bare-main-end-state --scope project --subject bottega`.

A review agent may edit and run tests to verify a hypothesis. Those edits are scratch evidence; a review worktree diff must not be landed. Implement and fix agents may commit to their run branch; they may not push, merge into trunk, or rewrite history. Review agents do not commit, push or merge. Admission to trunk is a GitHub pull request merged on GitHub after the local gate.

`hooks/protect-main-checkout.py` denies tracked-file `Write`/`Edit`/`NotebookEdit` inside a registered main checkout and names the worktree (both anchored lines). Not on Bash. `requireCleanMain` false is exempt. Fail-open on a missing database, malformed payload, or git failure. `hooks/no-attribution.py` denies `git commit`/`git merge`/`gh pr create` whose message credits an AI, including `-F` and `--body-file`. `.githooks/commit-msg` refuses the same patterns. Enable with `git config core.hooksPath .githooks`.

**An architect session with files to commit while workers are running uses a worktree, not a branch in the shared checkout** — branching there turns an ordinary commit into someone else's escape. **Landing happens in the disposable worktree, never the main checkout.**

# Lifecycle, locks and invariants

A run: `reserved` → `attached` → `running` → `asking` → `ok` | `failed` | `stopped` | `stale`. A chain inherits its last turn's state. A branch: `cut` → `built` → `reviewed` → `pull-requested` → `merged` | `abandoned`; rework outdates its review. Trunk moves through a GitHub pull request merged on GitHub.

Two lock purposes, two files. Creation and resume attachment take `project-lock.ts:withWorktreeCreateLock` (`orch-create.lock`). Cleanup from discard, abandon, stop and sweep takes `project-lock.ts:withCleanupLock` (`orch-cleanup.lock`). **One lock per purpose.** Same-tree attachment and cleanup take `project-lock.ts:withWorktreeLease` first, purpose lock second, so they cannot interleave or deadlock.

- **No limit loses staged work.** Writing runs checkpoint staged and modified tracked files every `DEFAULT_CHECKPOINT_MINUTES` and once more on wall, quota, context, cost, or operator stop. The checkpoint binds its commit to `$ORCH_SCRATCH/progress.json`; continuation receives that pointer. Stop keeps the worktree and branch.
- **The guard lives outside every root the worker can write.** Dispatch refuses a run whose guard path falls inside a writable root; it is published under the common git dir.
- **Orch never edits a vendor's trust store.** Leftover Grok trust is residue; sweep reports it for pruning.
- **Every write transaction is `IMMEDIATE`.** A deferred transaction that later writes is a lock-upgrade race under concurrent dispatch.
- **Divergence is classified and attributed, never fatal by itself.** Launch freezes tree hash (`git write-tree` plus untracked non-ignored paths) and `HEAD` for the run's project main and the caller checkout; exit re-hashes. Porcelain is a field of that freeze, not a second detector. A sample within `UNTRUSTED_INDEX_WINDOW_MS` of index mtime is untrusted and re-taken. A `HEAD` that moved with a clean tree is someone else's edit-commit cycle. Attribution is the `index.lock` holder, a historical landing row, or unattributed. The register names the landing branch.
- **Watch the run project and caller checkout, never a third project.**
- **Only an overlapping outside change blocks admission.** Overlap makes the run `escaped` and no pull request opens until the architect rules; otherwise the run completes with the event on its row. The detector never drops findings, scores, or the review. Root and trip-time tip are snapshotted so `orch confinement clear` needs no tip flag or hand seeding.
- **A resume is always possible on a stale checkout.** The caller-at-trunk check stops a new dispatch from stale input; it must never apply to a chain resuming in its own worktree, nor to a base/cwd that names a recorded run's tree. Exemption is explicit resume identity only (`dispatch-preflight.ts:namesRecordedRunTree`: realpath or commit, never a suffix or table scan). A stale new dispatch from some other run's recorded cwd is not exempt. Resume attachment takes the creation lock only for attribution, lease first.
- **Only the main checkout's binary migrates the store.** `ORCH_DB` only locates a store; `db.ts:initializeDatabase` and `db.ts:migrateDatabase` refuse a linked-worktree binary (`database-location.ts:resolveDatabase`). `orch migrate` applies the ordered, checksummed SQL journal; a behind store refuses before queries run. It stamps `PRAGMA user_version` with applied journal length; unstamped is not behind. `db()` re-reads at open and at every write transaction and refuses a shorter journal (both anchored lines). `orch mcp` and `hub serve` re-read per request and re-prepare instead of refusing. One `BEGIN IMMEDIATE` lock on a schema-lock row. `-- BACKFILL` re-executes idempotently; hashing uses DDL only. `spec_sha` backfills in TypeScript. Ahead ceiling keys on idx, not `when`. After merge the main checkout pulls and runs `orch migrate` and `hub migrate`. `schema-core.ts` is the typed declaration; Drizzle Kit cannot preserve table `UNIQUE` or `COALESCE` expression indexes, so SQLite migrations are hand-written SQL. Tests bootstrap through `db.ts:applySchemaForFixture` / `bootstrapFixtureStore`, never the production path. Expand-first for any column a running process still reads. `run-authority.ts:adoptRunMutation` is chain ownership, not schema. Postgres is schema-first: edit `postgres-schema.ts`, generate with `drizzle.postgres.config.ts`, commit folder and snapshot whole; never hand-edit generated `migration.sql`. Kit-inexpressible SQL (`FORCE ROW LEVEL SECURITY`, grants, seeds) goes in a custom migration. The migration role holds `CREATE` on the `drizzle` metadata schema; tenant roles have none. The gate proves snapshot-chain consistency and no ungenerated change. A terminal run row and its outbox row are one transaction. Review writes and outbox rows share a transaction; backfill mints parents first. `orch sync` pushes outbox rows as idempotent upserts keyed by locally minted ids. `orch sync --backfill` mints record ids for runs that predate the outbox and enqueues their terminal rows through the same path; a run is never written to the record except through the outbox.
- **A linked-worktree binary reads the main store and never writes it, whatever names the path.** `db.ts:linkedWorktreeReadOnly` refuses at the write handle; `ORCH_DB_WRITE` is the operator's explicit insistence. Tests refuse any store their preload did not mint under the temporary directory.
- **A lock waiter is served in arrival order** (`project-lock.ts:withProjectLock`, monotonic ticket under mkdir-atomic discipline).
- **Every wait, refusal and invalidation on a shared resource is recorded where it happens** (`contention`, same transaction). `orch health` prices the class. Never inferred later, never routing evidence.
- **Every refusal names the invariant it protects and the command that clears it.**
- **A reclaim removes exactly the acquisition it classified as stale, never a replacement** (`project-lock.ts:reclaimStaleProjectLock`, incarnation id after rename). Malformed or locale-dependent process output is unknown, never stale (`project-lock.ts:staleProjectLockHolder`, `project-lock.ts:processStartTime`).

Detach claims a reserved id before routing; the asking session still owns the run. `orch result` exits `2` for not-finished and `1` for failed. `orch wait` is bounded. `orch retry` re-sends the prompt to the same agent; the original failure still counts; a writing run continues via `orch continue` in the same worktree. Retry needs the prompt on disk, bounded by `KEEP_RUN_FILES_DAYS`. **Keep both ends of a failure.** **Both claim paths must set every meaningful column**, including `parent_run_id` and `turn`.

# Delegating implementation

An implement or fix worker gets a throwaway worktree, a spec, and a contract. It may commit to its own branch; it may not push, merge into trunk, or rewrite history. The architect judges the branch diff. The harness checkpoints every `DEFAULT_CHECKPOINT_MINUTES` and at every limit or stop. The worker writes `$ORCH_SCRATCH/progress.json` after each item. GitHub squash-merge folds checkpoint commits. `worktree-remove.ts:changesIn` stages everything and diffs against the immutable run base, so `orch diff` shows what it did while history shows authorship.

**Done describes the work, not the knowledge.** Consult a landed task's record instead of deriving it again.

`orch discard` and `orch abandon` remove the tree but keep a branch whose commits are reachable from nowhere else; the refusal names the commit count and the command that deletes it anyway. Empty and non-unique branches discard routinely. Abandoned unique commits remain. A merged branch is recoverable from the GitHub pull request.

**`writesRepo` is declared, never inferred from `readsRepo`.** Codex `--approve-for-me` is required for MCP and implies workspace-write; `mcpImpliesWrite` declares that, and any writable sandbox is put in a worktree whether or not the job writes. The failure is silent: an agent that cannot write reports success having changed nothing.

**`resumable` must mean orch can actually resume it, not that the CLI has a flag.**

**A conversation is one unit of work.** Later turns are rows; only the root is evidence and it carries the chain's outcome.

**`asking` is read before the success ladder.** Exit `0` with a reply looks like `ok`. A reply that does not parse is a failure.

**A reply is a file.** Every contract names its JSON schema and requires `$ORCH_SCRATCH/reply.json`. The harness reads that artifact first. Native schema flags are extra, not the carrier. The registration probe must write and validate this file before the row is eligible.

# A worktree belongs to the project

A project declares its lifecycle in the register and orch shells out to it; a project that declares none gets the built-in git worktree.

A `readsRepo` job without `writesRepo` does not use `create`, its branch template, seed resolver, or seed list. orch cuts a plain detached worktree and removes it with plain git, even when the project declares a writing recipe. `--key` remains useful for attribution; `--seed` is refused because seeds belong to writing runs. `worktree.readonly_create` is declared, never inferred from `create`. It uses `{path}` and `{base}`, must create a detached worktree, must have no side effects on task state, and must provision nothing outside the tree. Default removal is plain git. `worktree.readonly_remove` receives `{path}` only; writing-run `remove` and `sweep` are never used for it. `worktree.readonly_notes` is declared, never inferred. Without `readonly_create`, a read-only worker in a project with a writing lifecycle has files only; record suites that cannot start in `could_not_verify`, not as findings.

**Templates, not arguments.** Each project spells its own call. **How much database is the architect's call.** Where a project lists seeds and offers no default, orch refuses to invent one. `--seed` carries the project's whole spec through unchanged. Before a row exists, orch asks `scripts/worktree resolve`: `0` accepts, `2` rejects, `1` could not be checked and is also a hard stop; no resolver means pass-through.

**The worker is told what it has, in the project's own words.** Verifying against a server already running tests a different branch, and it passes.

# Cleaning up follows ownership

A run's tree is closed out when the run terminalises. Close-out and `orch sweep` release a tree unless someone is alive on it or it holds work that exists nowhere else. The branch is always kept. A finished conversation's sandbox directory is released with its tree. Sweep reports what it released, what was already absent while its recorded identity remains, and what it kept and why. Automatic teardown removes only a tree carrying the run's own ownership label; an attached tree is forgotten, never removed. A restore path that runs SQL checks table and constraint counts after, never exit status alone. Then each project's own sweep runs.

# Two ways to ask

The durable protocol is `status: blocked` in the return contract. The live channel is `ask_orchestrator`, registered with `orch setup-ask`. The worker calls it mid-task; the turn is never lost. **It always answers.** On timeout it instructs the worker to stop and report the question in the final answer, so the fast path degrades into the durable one rather than a hang. The question stays open either way.

**The run id comes from the environment, never from the tool arguments.**

**A writing job gets MCP whether or not the caller asked for it.**

**The MCP-versus-sandbox trade is Codex's, not the system's.** `--approve-for-me` is required for Codex MCP and mutually exclusive with `--sandbox`. Grok has no such conflict.

**Headless grok must never be able to prompt.** Every grok run uses `bypassPermissions`. The worktree and the dirtied-tree detector are the guards.

**Run messages are context, not rulings.** `orch tell` queues; queued is never reported as delivered. A message cannot close an open question or relax the escalation contract.

**`answer` refuses a chain with nothing open; `continue` refuses one that is waiting.** Resuming a waiting worker makes it guess. A resumed turn is detached, like everything else.

# A delegated agent is not a trusted one

**Delegation bottoms out at one level.** `ORCH_DEPTH` is set on every child; `orch do` refuses to start when it is already set.

**The child does not inherit this session's identity, or an Anthropic key.** Every `CLAUDE_*` and `ANTHROPIC_*` variable is stripped.

**Every run is bounded and every child is reaped.** `timeoutMs` is held below `STALE_AFTER_MS`. `SIGINT`/`SIGTERM` take children with the parent; the terminal row is written from a `finally`. The pid is recorded immediately after spawn, not after the wait.

# Parallel launches share one database

Concurrent `orch do` processes write the same SQLite file. `PRAGMA busy_timeout` makes a blocked writer wait rather than fail.

# A tool that cannot see its data refuses

It never reports emptiness as a finding. "No rows", "no task", "nothing to do" are answers **only** when it looked at the right data and found nothing. When it cannot reach the data it exits nonzero and names what it could not reach. Machine-readable output must error, never a zero, when the data was not seen.

# The test gate

One in-process `bun test` over `orchestrator/src`, with the test preload, under `gate-load.ts`: at most `GATE_CONCURRENCY_LIMIT` running gates, waiting while loadavg is at or above ncpu or free RAM is under `FREE_MEM_FLOOR_BYTES`. Timing ratchet only moves down. A unit test file above `SPAWN_LIMIT` Bun spawn or spawnSync calls fails `scripts/check-test-spawns.ts`. No size classes, shards, subprocess test leg, or retry path.

# Prompts and replies age out

`KEEP_RUN_FILES_DAYS` bounds verbatim packs and answers under `runs/`. The row stays; only the text ages out.
