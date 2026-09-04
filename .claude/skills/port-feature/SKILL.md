---
name: port-feature
description: Port task-management / workflow / MCP subsystem features between projects registered in orch. Scans the source project for changes since the last port, filters through recorded per-project differences, and stages adapted tasks in the target project via its MCP server. The ledger, doctrine, baselines and differences live in orch.db, not in files.
---

# Port Feature Between Projects

Several projects on this machine share the same developer-built
project-management and system-management design: task/workflow/MCP subsystems,
monitoring and ops reporting, and the dev-experience layer. This skill finds what
changed in one and stages tasks to port it to another, without rehashing the
known, intentional differences every time.

**Which projects is a question for the register, not this file.** Run
`orch project list` — pairs, key prefixes, trunks and checkout paths all come
from there. Do not hardcode a project list; earlier versions of this skill did
and it is why the data had to be moved.

## Where the substance lives

It is in `orch.db`, reachable through `orch port` and `orch doc show`. There are
no supporting files in this directory any more.

| what | how to read it |
|---|---|
| the portability test and settled doctrine | `orch port doctrine list`, and `orch doc show port-doctrine-preface --scope global` |
| what a project deliberately keeps unique | `orch doc show port-differences --scope project --subject <name>` |
| stack translation notes | `orch doc show port-stack-mapping --scope global` |
| process differences | `orch doc show port-process-differences --scope global` |
| the category scan map — what lives where | `orch doc show port-category-map --scope global` |
| improvements owed back to a project | `orch doc show port-backports --scope project --subject <name>` |
| the ledger | `orch port ref list`, `orch port ref show <TASK-KEY>` |
| scan progress for a pair | `orch port baseline show <source> <target>` |
| features deliberately skipped | `orch port skip list <source> <target>` |
| what could not be represented at migration | `orch doc show port-import-exclusions --scope global` |

## Workflow

1. **Determine source and target.** If not given, ask. Any registered pair; one
   source may target several projects. Confirm both are registered:
   `orch project list`.

2. **Determine WHAT FEATURE, before scanning anything.** Ask which feature or
   subsystem is being ported. Do not scan first and offer a menu afterwards —
   a source project may carry thousands of commits, and surveying all of them to
   then pick one is work thrown away. Name the feature, then scan for it.

   You will usually be able to propose candidates without a scan at all, from
   what the two projects are already recorded as sharing: read the target's
   differences doc and the category map, which say what exists on both sides and
   what is deliberately absent. Offer those, with what each would mean in the
   target, and let the user choose.

   A BROAD SURVEY IS THE FALLBACK, not the default. It is right only when nobody
   knows what is available and the user asks for one explicitly. Scope it to the
   source's project-management layer and say up front what it will cost.

   If the user names a feature the target must never receive, say so now and stop
   — the differences doc records refusals that were already ruled on, and
   re-litigating one at staging time wastes the ruling.

3. **Load context.** Read the doctrine, the target's differences, the stack
   mapping and the category map from the table above. Get the pair's baseline
   with `orch port baseline show <source> <target>`. A pair with no baseline has
   never been scanned — that is not an error, it is a first run.

4. **Consult the ledger, and RESOLVE rather than delete.** For each entry
   targeting this project (`orch port ref list`), if its task is now complete,
   run `orch port ref resolve <TASK-KEY>`. Do NOT delete it. A resolved ref is
   kept deliberately: deleting it would make "this port completed" and "this was
   never ported" indistinguishable, including to a later scan deciding whether
   to offer the same work again. `orch port ref delete-error <TASK-KEY>` exists
   only for a ref recorded in error, and is not the same act.

5. **Scan the source, SCOPED TO THE FEATURE from step 2.** In the source's
   checkout, run `git log` / `git diff --stat` over only that feature's paths,
   from the baseline SHA to origin's default branch HEAD. Fetch first and use the
   remote branch, not the local checkout state. With no baseline, the window is
   the source's full history for those paths — say so rather than cutting at an
   arbitrary date, and if the history is large, ask.

   Read the feature's own history, not just its current state. Commit messages
   on a gate or a guard are a list of things that actually went wrong, and they
   are usually more informative than the diff.

   **Re-verify the source's layout before trusting recorded paths.** These
   projects restructure. One moved its whole API between two runs of this skill
   eleven days apart. A scan path returning zero commits is far more often a
   moved directory than a quiet period, so check the tree before reporting
   "nothing to port", and correct the category map when you find drift (step 10).

6. **Filter.** Apply the portability test from the doctrine first: only
   project-management / system-management layer changes are candidates, and
   product-domain changes are dropped outright. Then drop anything the target's
   differences doc records as deliberately unique, and anything already skipped
   for this pair (`orch port skip list`).

   Ask what the ADAPTED version would be, not whether the code applies. Where
   the two projects differ in shape, a port is a pattern re-expressed, and a
   candidate that would require restructuring the target to receive it is a
   refusal rather than a large task.

7. **Present what you found.** What it does in the source, with its paths and the
   commits that built it; what the adapted version would mean in the target,
   concretely; rough size; and what in the target ALREADY does part of this,
   which must be reported rather than proposed again. Also present anything owed
   to this target from its backports doc — improvements another project made over
   the target's implementation, which a git scan of the source will never
   surface. Let the user confirm before anything is staged.

8. **Stage tasks in the target** via its MCP server. One task per selected
   feature, carrying the description, the target-convention adaptation notes and
   any doctrine or difference constraints that apply. Do not implement; this
   skill stages work.

   **The task must not name the source project, its commits or its paths.**
   Titles are written purely in the target's own terms — "Add queue retry
   backoff", never "Port project X's retry backoff". The provenance goes in the
   ledger instead:

       orch port ref set <TASK-KEY> --sources '[{"source_project_id":N,"commits":[...],"paths":[...],"note":"..."}]' --note "..."

   A ref may name SEVERAL source projects; that is what the array is for. Put
   any qualifying text — "as a stated gap, not an implementation" — in that
   source's own `note` rather than dropping it.

   End the task description with the single neutral line
   `Porting reference: orch port ref show <TASK-KEY>`. That is how the
   implementer finds the source material.

9. **Update scan progress.** Write the scanned source HEAD to the pair:
   `orch port baseline set <source> <target> <commit>`. Move the baseline ONLY
   over the paths you actually scanned — a feature-scoped scan does not entitle
   you to claim the whole tree was examined, and a baseline that overstates its
   coverage silently hides everything it skipped from the next run. If the scan
   was scoped, say so in the skip or leave the baseline unmoved.

   For each feature the user declined, record it with its reason:
   `orch port skip add <source> <target> "<candidate>" --reason "<why>"`. The
   reason is required and is the point — a skip with no reason cannot be
   distinguished later from an oversight.

10. **Maintain the record.** A newly stated intentional difference goes into the
    target's differences doc immediately (`orch doc set port-differences --scope
    project --subject <name> --title "Port differences" --file <path>`); read it
    first and append rather than overwrite. A new cross-project standard becomes
    a doctrine rule (`orch port doctrine add <number> --title TEXT --file <path>`);
    retire a superseded one with `orch port doctrine retire <number>`, which keeps
    its number rather than reusing it. When a port deliberately improves on its
    source, append that to the SOURCE project's backports doc — that is how the
    source picks the improvement up on a later run, via step 7.

## Two rules that are easy to get wrong

**Resolution is state, not deletion.** Step 3. It applies to skips and doctrine
rules too: a retired rule keeps its number.

**Refuse rather than guess.** If a project is not registered, a task key has no
owning project, or a source cannot be resolved to a registered project, stop and
say so. Do not infer a project from a name that looks close.
