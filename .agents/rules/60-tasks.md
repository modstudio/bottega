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

File an observation with `orch note`. A note is one line of free text; project,
run, branch, session, commit and any file anchor are derived at write time. Do
not use a shared document as a suggestion ledger.

Search for near entries when filing. Mark a repeated observation through `hub
note same`, which increments its count and adds a sighting. Never run scheduled
text-similarity merging, because similar findings may be distinct. Repetition
with cost is the promotion signal.

Staleness is mechanical: anchors disappear when their file location, run,
branch or commit range disappears. `hub note stale` marks vanished anchors and
reaps only stale singleton notes untouched through the staleness window and
never promoted. `hub note curate` runs curation, and `hub note curator`
controls scheduled curation. All other disposition is human.

Promotion is always a human act through `hub note promote`; the task carries
the note body and sightings as evidence. Scheduled work never promotes and the
board never grows by itself. Filing belongs to `orch note`, while keeping,
promoting, dropping and merging belong to `hub note`.

If an entry needs fields beyond text, tags and sightings, it is a task. Promote
it instead of building another tracker inside notes.
