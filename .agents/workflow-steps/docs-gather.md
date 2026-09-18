---
title: Gather the change and its documentation
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  - tracker
  - docs
---
In `{{worktree}}`, establish exactly what changed for `{{key}}`: inspect the branch and commit history, the complete diff from its merge base, and every staged or unstaged change. When the optional scope argument is present in the composition, limit the sweep to that path or area without treating it as permission to ignore dependencies the scoped change alters.

Read the task and every linked task document through the tracker named in `facts`. Through the docs adapter named in `facts`, search for and read the project canon, decision records, and knowledge-base entries that describe the changed behavior, interfaces, patterns, or operating rules. Read relevant global, stack, and project documents named by the composition as well. Do not edit a hydrated canon file; it is a mirror, not the write authority.

Record a gather artifact that names the comparison base and head, changed files and behavior, task documents read, canon and knowledge-base entries read, relevant searches that returned no match, and any source that could not be read. This step is done only when the artifact is sufficient to compare the implemented change with every document that claims to describe it.
