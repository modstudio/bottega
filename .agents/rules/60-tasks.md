---
description: Inbox-zero task policy and the suggestion-box lifecycle
always: true
---

# Tasks are current work

File a task for work being done now. Do not keep a speculative backlog. Plans
live in the doc store and become tasks when implementation begins, because a
board must show what is actually happening.

A defect found during other work is still fixed or delegated in that session.
Inbox zero forbids speculative rows, not the rule that a filer owns disposition.

## Suggestions are observations, not tasks

File an observation with `bottega note new`. A note is one line of free text; project,
run, branch, session, commit and any file anchor are derived at write time. Do
not use a shared document as a suggestion ledger.

Search for near entries when filing. Mark a repeated observation through `bottega
note same`, which increments its count and adds a sighting. Never run scheduled
text-similarity merging, because similar findings may be distinct. Repetition
with cost is the promotion signal.

Staleness is mechanical: an anchor vanishes when its branch is deleted or
landed, or its run, file or line text is gone, in its own repository. Triage is
a promotion, drop, merge, or keep by a non-reporter. `bottega note stale`
annotates untriaged notes and reaps only stale, triaged, unpromoted singletons
past the staleness window. All other disposition is human.

Promotion is always a human act through `bottega note promote`; the task carries
the note body and sightings as evidence. Scheduled work never promotes and the
board never grows by itself. `bottega note new` files a note; `bottega note same`,
`keep`, `promote` and `drop` dispose of it.

If an entry needs fields beyond text, tags and sightings, it is a task. Promote
it instead of building another tracker inside notes.
