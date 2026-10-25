---
description: Disposable runs, worktrees, locks, escalation, cleanup, and the test gate.
paths:
  - orchestrator/src/**
  - orchestrator/hooks/**
  - orchestrator/test/**
---

# Disposable runs

A repo job runs in its own throwaway worktree. Orch carries the caller's visible git state (committed, staged, unstaged, deletions, binaries, non-ignored untracked). Ignored runtime state is provisioned by the project's recipe, never copied from another checkout.

The worktree is the safety boundary. A repository agent gets workspace-write for its tree: a reader's clone with its own `.git`, or a writer's linked worktree and metadata. A reader never pushes; its guard's `pre-push` refuses from outside its writable roots. A run carries `BOTTEGA_MAIN_CHECKOUT`; tooling reads it, not git layout, to find main. A writing worker also gets the common object store and the directories holding its own run-branch ref and reflog. The ref guard permits only that exact branch. Never use `CODEX_EXEC_SANDBOX` for a repository run. Inline jobs (`summarize`, `review-lens-inline`) create no worktree.

**A registered main checkout stays clean.** A dispatch from the main checkout refreshes its index and refuses tracked modifications, naming the dirty paths and the worktree (both anchored lines); other trees go unchecked. Untracked files warn; ignored files are silent. Default on; opt out with `requireCleanMain` false. Resumes skip the check. Bare-main end state: project doc `bare-main-end-state`.

Review agents may edit and test as unlanded scratch; they never commit, push or merge. Writers commit to run branches but never push, merge into trunk or rewrite history. Trunk admits work only by GitHub pull request through the merge queue; after merging a reworked run, run `bottega tree branch landed`.

`hooks/protect-main-checkout.py` blocks tracked writes and ruled Bash Git mutations in registered main (`-C` else cwd); worktrees excluded; `requireCleanMain` false exempts; unparsed pass. `hooks/git-guard.py` asks before a destructive push and allows git in a project worktree, also via `bottega workflow exec`. `hooks/no-attribution.py` denies `git commit`/`git merge`/`gh pr create` crediting an AI, also `-F`/`--body-file`; `.githooks/commit-msg` does too. Enable with `git config core.hooksPath .githooks`.

**An architect session with files to commit while workers are running uses a worktree, not a branch in the shared checkout** — branching there turns an ordinary commit into someone else's escape. **Landing happens in the disposable worktree, never the main checkout.**

# Lifecycle, locks and invariants

A run: `reserved` → `attached` → `running` → `asking` → `ok` | `failed` | `stopped` | `stale`. A chain inherits its last turn's state. A branch: `cut` → `built` → `reviewed` → `pull-requested` → `merged` | `abandoned`; rework outdates its review. Trunk moves through a GitHub pull request merged on GitHub.

Two lock purposes, two files. Creation and resume attachment take `project-lock.ts:withWorktreeCreateLock` (`orch-create.lock`). Cleanup from discard, abandon, stop and sweep takes `project-lock.ts:withCleanupLock` (`orch-cleanup.lock`). **One lock per purpose.** Same-tree attachment and cleanup take `project-lock.ts:withWorktreeLease` first, purpose lock second, so they cannot interleave or deadlock.

- **No limit loses staged work.** Writing runs checkpoint staged and modified tracked files every `DEFAULT_CHECKPOINT_MINUTES` and once more on wall, quota, context, cost, or operator stop. The checkpoint binds its commit to `$BOTTEGA_SCRATCH/progress.json`; continuation receives that pointer. Stop keeps the worktree and branch.
- **The guard lives outside every root the worker can write.** Dispatch refuses a run whose guard path falls inside a writable root; it is published under the common git dir.
- **Vendor trust changes only via `bottega machine reclaim trust`**: one recorded absent orchestrator worktree, never main.
- **Every write transaction is `IMMEDIATE`.** A deferred transaction that later writes is a lock-upgrade race under concurrent dispatch.
- **Divergence is classified and attributed, never fatal by itself.** Launch freezes tree (`git write-tree` plus untracked non-ignored paths) and `HEAD` for project main and caller; exit re-hashes. Porcelain is part of the freeze. Samples within `UNTRUSTED_INDEX_WINDOW_MS` of index mtime are untrusted and retried. A clean-tree `HEAD` move is an outside edit-commit cycle. Attribution is the `index.lock` holder, a historical landing row, a worktree claim released after the run began (attributed to its owner session), or unattributed. The register names the landing branch.
- **Watch the run project and caller checkout, never a third project.**
- **Only an overlapping outside change blocks admission.** Overlap makes the run `escaped` and no pull request opens until the architect rules; otherwise the run completes with the event on its row. The detector never drops findings, scores, or the review. Root and trip-time tip are snapshotted so `bottega review confinement clear` needs no tip flag or hand seeding.
- **A resume is always possible on a stale checkout.** The caller-at-trunk check stops a new dispatch from stale input; it must never apply to a chain resuming in its own worktree, nor to a base/cwd that names a recorded run's tree. Exemption is explicit resume identity only (`dispatch-preflight.ts:namesRecordedRunTree`: realpath or commit, never a suffix or table scan). A stale new dispatch from some other run's recorded cwd is not exempt. Resume attachment takes the creation lock only for attribution, lease first.
- **Only the main checkout's binary migrates the operator store; a linked-worktree binary may migrate a store only when its real path is inside the OS temporary directory.** The SQLite journal is ordered and checksummed; a behind store refuses before queries run, and `-- BACKFILL` blocks re-execute idempotently. After a merge, `bottega machine update` drains runs, pulls and migrates. A terminal run row and its outbox row are one transaction. Review writes and outbox rows share a transaction; backfill mints parents first. Every other evidence kind follows the same outbox-only record rule. `bottega record push` idempotently upserts outbox rows by local id. `bottega record push --backfill` mints record ids for pre-outbox runs and enqueues their terminal rows through the same path; a run reaches the record only through the outbox.
- **Linked worktrees and borrowed clones only read both stores; workers only read the hub store.** `store-access.ts:decideStoreAccess` decides it; `BOTTEGA_ORCHESTRATOR_DB_WRITE` is the operator's explicit insistence. Tests refuse any store their preload did not mint under the temporary directory.
- **A lock waiter is served in arrival order** (`project-lock.ts:withProjectLock`, monotonic ticket under mkdir-atomic discipline).
- **Every wait, refusal and invalidation on a shared resource is recorded where it happens** (`contention`, same transaction). `bottega machine health` prices the class. Never inferred later, never routing evidence.
- **A reclaim removes exactly the acquisition it classified as stale, never a replacement** (`project-lock.ts:reclaimStaleProjectLock`, incarnation id after rename). Malformed or locale-dependent process output is unknown, never stale (`project-lock.ts:staleProjectLockHolder`, `project-lock.ts:processStartTime`).

Detach claims a reserved id before routing; the asking session still owns the run. `bottega run result` exits `2` for not-finished and `1` for failed. `bottega run wait` is bounded. `bottega run retry` re-sends the prompt to the same agent; the original failure still counts; a writing run continues via `bottega run continue` in the same worktree. Retry needs the prompt on disk, bounded by `KEEP_RUN_FILES_DAYS`. **Keep both ends of a failure.** **Both claim paths must set every meaningful column**, including `parent_run_id` and `turn`.

# Delegating implementation

Writing runs checkpoint on schedule and at limits or stop. Update `$BOTTEGA_SCRATCH/progress.json` after each item. `worktree-remove.ts:changesIn` preserves the full diff against the immutable run base.

Workers do not register Git worktrees; they make baseline copies under `$BOTTEGA_SCRATCH`.

**Done describes work, not knowledge.** Consult a landed task's record instead of deriving it.

`bottega run discard` and `bottega run abandon` remove the tree but retain uniquely reachable commits; refusals name their count and forced-deletion command. Empty and non-unique branches discard routinely; merged branches are recoverable from GitHub pull requests.

**`writesRepo` is declared, never inferred from `readsRepo`.** Codex `--approve-for-me` is required for MCP and implies workspace-write; `mcpImpliesWrite` declares that, and any writable sandbox is put in a worktree whether or not the job writes. The failure is silent: an agent that cannot write reports success having changed nothing.

**`resumable` must mean the orchestrator can actually resume it, not that the CLI has a flag.**

**A conversation is one unit of work.** Later turns are rows; only the root is evidence and it carries the chain's outcome.

**`asking` is read before the success ladder.** Exit `0` with a reply looks like `ok`. A reply that does not parse is a failure.

**Replies are files.** Contracts require schema-bound `$BOTTEGA_SCRATCH/reply.json`, read before the final message; schema flags are supplemental. The registration probe writes and validates it before eligibility.

**Writing replies order their diff.** `change_guide` puts decisions first and mechanical follow-ons last. Its steps partition changed repo-relative files; each explains its part and names one check. It guides reading without replacing the diff or summary. No file changes means null.

# A worktree belongs to the project

A project's lifecycle is managed with hooks, fully managed or plugged in (root entry); one that declares none gets the built-in git worktree.

`bottega tree refresh` fast-forwards a clean worktree to trunk and runs the recipe's repeatable `refresh` steps; it never rebases, and its refusal is a failure to report.

A `readsRepo` job without `writesRepo` does not use `create`, its branch template, seed resolver, or seed list. The system makes a `git clone --shared` of the main checkout, detached at the base with no remote, even when the project declares a writing recipe. Never register a store as an alternate of main: git skips objects an alternate holds, so removing that store corrupts main. Removal deletes a clone only after `worktree-remove.ts:readOnlyRemovalRefusal` passes, never by `git worktree remove`. `shared/git.ts:borrowedCheckoutFromAlternates` makes a clone answer its source checkout. `--key` remains useful for attribution; `--seed` is refused because seeds belong to writing runs. `worktree.readonly_create` is declared, never inferred from `create`. It uses `{path}` and `{base}`, must produce a detached checkout of `{base}` whose objects borrow the main checkout's, must have no side effects on task state, and must provision nothing outside the tree. `worktree.readonly_remove` receives `{path}` only; writing-run `remove` and `sweep` are never used for it. `worktree.readonly_notes` is declared, never inferred. Without `readonly_create`, a read-only worker in a project with a writing lifecycle has files only; record suites that cannot start in `could_not_verify`, not as findings.

**Tracked recipe teardown.** `undo` and `verifyDown` may run after the tree is gone, from an empty directory: call `{main}/…` and derive targets from the tree name.

**Templates, not arguments.** Each project spells its own call. **How much database is the architect's call.** Where a project lists seeds and offers no default, the system refuses to invent one. `--seed` carries the project's whole spec through unchanged. Before a row exists, it asks `scripts/worktree resolve`: `0` accepts, `2` rejects, `1` could not be checked and is also a hard stop; no resolver means pass-through.

**The worker is told what it has, in the project's own words.** Verifying against a server already running tests a different branch, and it passes.

# Cleaning up follows ownership

A run's tree closes when the run terminalises. Close-out and `bottega machine sweep` release it unless someone is alive there or it holds unique work. Close-out keeps the branch for landing. Sweep deletes a run-minted branch only when the prune classifier proves it landed, superseded or empty, never when unlanded or unknown. `bottega machine reclaim branch` requires the same proof for commits absent from trunk: a recorded tip proves identity, not landing. If the tree is already absent, close-out releases the run's ref guard and retained ref. Sweep retries terminal rows still held or failed, and reclaims grok trust entries whose tree is gone. A finished conversation's sandbox is released with its tree. Sweep reports releases, absent recorded identities, and everything kept with its reason. Automatic teardown removes only the run-labelled tree; an attached tree is forgotten, never removed. A restore path checks SQL table and constraint counts, never exit status alone. Then each project's sweep runs.

**Land from a project-provisioned tree.** `bottega tree open <run>` opens an architect-owned tree on a finished run's branch through the project's lifecycle; a command-template `create` must accept `{branch}`. `bottega tree remove` releases it; sweep only when it is clean and landed. Never land from a hand-made `git worktree add`.

# Two ways to ask

The durable protocol is `status: blocked` in the return contract. The live channel is `ask_orchestrator`, registered with `bottega machine setup-ask`. The worker calls it mid-task; the turn is never lost. **It always answers.** On timeout it instructs the worker to stop and report the question in the final answer, so the fast path degrades into the durable one rather than a hang. The question stays open either way.

**The run id comes from the environment, never from the tool arguments.**

**A writing job gets MCP whether or not the caller asked for it.**

**The MCP-versus-sandbox trade is Codex's, not the system's.** `--approve-for-me` is required for Codex MCP and mutually exclusive with `--sandbox`. Grok has no such conflict.

**Headless grok must never be able to prompt.** Every grok run uses `bypassPermissions`. The worktree and the dirtied-tree detector are the guards.

**Run messages are context, not rulings.** `bottega run tell` queues; queued is never reported as delivered. A message cannot close an open question or relax the escalation contract.

**`answer` refuses a chain with nothing open; `continue` refuses one that is waiting.** Resuming a waiting worker makes it guess. A resumed turn is detached, like everything else.

# A delegated agent is not a trusted one

**Delegation bottoms out at one level.** `BOTTEGA_DEPTH` is set on every child; `bottega run start` refuses to start when it is already set.

**The child does not inherit this session's identity, or an Anthropic key.** Every `CLAUDE_*` and `ANTHROPIC_*` variable is stripped.

**Every run is bounded and every child is reaped.** `timeoutMs` is held below `STALE_AFTER_MS`. `SIGINT`/`SIGTERM` take children with the parent; the terminal row is written from a `finally`. The pid is recorded immediately after spawn, not after the wait.

# A tool that cannot see its data refuses

It reports emptiness only after looking at the right data. Otherwise it exits nonzero and names what it could not reach; machine-readable output errors rather than returning zero.

# The test gate

`gate-load.ts` runs `bun test` preloaded in-process on `orchestrator/src`. `GATE_CONCURRENCY_LIMIT` bounds gates; others wait for load and RAM (macOS kernel pressure, else `FREE_MEM_FLOOR_BYTES`), a wait CI skips. Timing only ratchets down. `scripts/check-test-spawns.ts` caps Bun spawns at `SPAWN_LIMIT`. CI runs one job per `bun test --shard`. `scripts/check-plan.ts` names its legs; `scripts/check-ci-workflow.ts` pins the workflow to them. No size classes, subprocess leg or retry path.

# Prompts and replies age out

`KEEP_RUN_FILES_DAYS` bounds verbatim packs and answers under `runs/`. The row stays; only the text ages out.
