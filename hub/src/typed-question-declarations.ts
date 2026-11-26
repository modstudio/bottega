// concern: typed-question-declarations
/** Declares every hub-owned typed-question version retained for reports and backtests. */

import { NOTE_DUPLICATE_QUESTION } from './note-duplicate-question.ts'
import type { ChoiceQuestion } from '../../shared/typed-question/registry.ts'

export const NOTE_CLASS_QUESTION: ChoiceQuestion = {
  id: 'note_class',
  version: 1,
  type: 'choice',
  threshold: 0.5,
  instructions:
    'The state is one defect note filed against a developer tool. Choose the defect class whose definition the note is an instance of. Choose none when no definition fits.',
  criteria: {
    C1: 'Unbounded calls: a call to a process, network service or lock that has no deadline, so a hang stalls its caller.',
    C2: 'Shared state changed and reported as success: a verb changes shared state, partly or fully, and then reports success or a misleading failure.',
    C4: 'Vendor failure classified by message wording: a vendor failure is classified by matching its message text rather than a structured signal.',
    C5: 'Reviews or gates that pass without their inputs: a review, gate or floor reports a pass although the input it judges was missing or unreadable.',
    C6: "Local store write contention: writes to hub.db or orchestrator.db are refused as 'database is locked' by another writer.",
    C7: 'Calls that take seconds on a small dataset: a CLI or API call takes seconds or minutes on a dataset of a few thousand rows.',
    none: 'The note is not an instance of any class above.',
  },
}

export const NOTE_CLASS_ACCEPT_CONFIDENCE = 0.8

export const TYPED_QUESTION_DECLARATIONS = [NOTE_DUPLICATE_QUESTION, NOTE_CLASS_QUESTION] as const
