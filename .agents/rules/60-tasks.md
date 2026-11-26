---
description: Inbox-zero task policy and the suggestion-box lifecycle
always: true
---

# Tasks are current work

File a task for work being done now. Do not keep a speculative backlog. Plans
live in the doc store and become tasks when implementation begins, because a
board must show what is happening.

A defect is filed as a note, not fixed alone. Triage dedupes it and attaches
it, as evidence, to the existing task for its class; it is fixed when its class
is fixed. Nothing is fixed on arrival; classes are fixed in batches, ranked by
notes and sightings. A board request about a note follows the
same triage.

Triage drops a note whose cause goes away once its project plugs into Bottega,
rather than Bottega plugging into the project. It promotes only a defect in
Bottega's own code that would survive that move.

A class is a task `Class <code>: <name>` under the class epic, with checked
evidence attached by comment, never as a child task a board counts as open
work. It is fixed once, after research and a build-or-buy ruling, by a root fix
with a class guard.

## Suggestions are observations, not tasks

File an observation with `bottega note new`. A note is one line of free text; project,
run, branch, session, commit and any file anchor are derived at write time.

Mark a repeated observation with `bottega note same`, which increments its count
and adds a sighting. Never run scheduled text-similarity merging, because similar
findings may be distinct; record such a pair with `bottega note distinct`.
Repetition with cost is the promotion signal.

Staleness is mechanical: an anchor vanishes when its branch is deleted or
landed, or its run, file or line text is gone. Triage is
a promotion, drop, merge, or keep by a non-reporter. `bottega note stale`
annotates untriaged notes and reaps only stale, triaged, unpromoted singletons
past the staleness window. All other disposition is human.

Promotion is always a human act through `bottega note promote`; the task carries
the note body and sightings as evidence. Scheduled work never promotes and the
board never grows by itself.

If an entry needs fields beyond text, tags and sightings, it is a task. Promote
it instead of building another tracker inside notes.
