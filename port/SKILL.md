---
name: port-feature
description: Port task-management / workflow / MCP subsystem features between Starship, Stopal, Alephbeis, and Adanim. Scans the source project for changes since the last port, filters through documented per-project differences, and creates adapted tasks in the target project via its MCP server.
---

# Port Feature Between Projects

All four projects (Starship, Stopal, Alephbeis, Adanim) share the same developer-built project-management and system-management design: task/workflow/MCP subsystems, monitoring & ops reporting, and the whole dev-experience layer (multi-instance setup, app config systems, CI/quality gates, sync/release tooling). This skill finds what changed in one project and creates tasks to port it to the others — without rehashing the known, intentional differences every time.

Adanim is the youngest of the four and still the thinnest in monitoring, knowledge and ops tooling, and it has **no CI at all** — the largest single gap anywhere in the set. But it is not simply behind: its MCP layer (tRPC reflection, deployment election, per-call audit), its code-declared workflows with load-time validation, and its canon-truthfulness gate are all ideas the older three lack. Treat it as a real source as well as a target; see `projects.md` §3, §7 and §2.

Supporting files in `port/` (this concern's directory):
- `projects.md` — workspace resolution, per-project stacks/layouts, the category scan map, and MCP task-creation tools
- `doctrine.md` — the portability test + settled cross-project best practices every port conforms to
- `differences.md` — what each project intentionally keeps unique (NOT ported) and stack translation notes
- `backports.md` — running list of improvements a port made over its source implementation; each is a pending feed-back candidate for the beneficiary project
- `state.json` — last-ported commit SHA per `source->target` pair, plus skipped features
- `refs.json` — porting ledger: per pending task key, the source project, commits, and paths (kept here so target tasks stay free of external references — doctrine #20)

## Workflow

1. **Determine source and target.** If not given as arguments, ask the user which project to port FROM and TO (any pair of starship/stopal/alephbeis/adanim; one source may target multiple projects).

2. **Load context.** Read `projects.md`, `doctrine.md`, and `differences.md` from `port/`, and `state.json` for the `source->target` baseline SHA.

3. **Prune the ledger.** For each existing `refs.json` entry targeting this project: if its task is now completed, delete the entry and edit the task's description to remove the `Porting reference:` line — once implemented, the pointer has served its purpose and the task should carry no trace of it.

4. **Scan the source for changes.** In the source's canonical workspace (see projects.md), run `git log` / `git diff --stat` over ONLY the configured scan paths, from the baseline SHA to origin's default-branch HEAD (fetch first; use the remote branch, not the local checkout state). If no baseline exists for the pair, ask the user how far back to look (default: 30 days).

   **Re-verify the source's layout before trusting `projects.md` paths.** These projects restructure — adanim moved its whole API from `modules/*` to `contexts/*` + `kernel/*` between two runs of this skill, eleven days apart. A scan path that returns zero commits is far more often a moved directory than a quiet period, so check the tree before reporting "nothing to port", and update `projects.md` when you find drift (step 9).

5. **Filter.** First apply the **portability test** in `doctrine.md`: only project-management / system-management layer changes are candidates; product-domain changes are dropped outright. Then drop changes that:
   - fall under the target's "keep unique / do not port" entries in `differences.md`
   - are pure refactors/renames with no behavior change
   - already exist in the target (spot-check the target's equivalent paths before proposing)

6. **Present the portable changes.** Group by feature (not by commit). For each: what it does in the source, what the adapted version means in the target given the stack mapping in `differences.md` (e.g. Laravel domain code ↔ Bun/TS module), and rough size. Also present any pending `backports.md` entries directed at this target (`## → <target>`) — improvements another project made over the target's implementation that a git scan of the source won't surface. Let the user pick which to port.

7. **Create tasks in the target** via its MCP server (tool names in projects.md). One task per selected feature, containing: the feature description, the target-convention adaptation notes, and any doctrine/difference constraints that apply. Do not start implementing — this skill only stages the work. Per doctrine #20, the task never names the source project, its commits, or its paths — titles are written purely in the target's own terms ("Add queue retry backoff", not "Port Starship's retry backoff"). Instead:
   - Record a `refs.json` entry keyed by the new task key: `{ "<TASK-KEY>": { "source": "<project>", "commits": [...], "paths": [...], "notes": "..." } }`.
   - **Only record commit SHAs that are ancestors of the source's default branch** — verify each with `git merge-base --is-ancestor <sha> origin/<default>`. Feature→develop is squash-merged (doctrine #6), so a SHA taken from an unmerged feature branch is collapsed and garbage-collected the moment that work ships — leaving a dead pointer exactly when the implementer follows it. When porting work that has not merged yet, record the PR number and branch name instead of branch SHAs, and resolve them to the squash commit on a later run. `paths` are stable and are what the implementer actually navigates by; treat SHAs as a convenience, never the only pointer.
   - End the task description with the single neutral line `Porting reference: ~/Projects/bottega/port/refs.json → <TASK-KEY>` — that's how the implementer finds the source material.
   - The ledger tells the implementer to record any deliberate improvement over the reference in `backports.md` — that's how the source project picks the improvement up on its next port run (step 6).

8. **Update state.** Write the scanned source HEAD SHA to `state.json` for this `source->target` pair. If the user skipped some features, record the skipped list inside `state.json` under `skipped` (or leave the baseline unmoved for those paths).

9. **Maintain the docs.** If during the run the user states a new intentional difference ("we don't want X in stopal"), add it to `differences.md` immediately; a new cross-project standard goes in `doctrine.md`. When a port deliberately improves on its source (or an implementer reports such a divergence), append it to `backports.md` under the source project's section — staged as a task in that project on a later run, then checked off. That's the whole point of those files.
