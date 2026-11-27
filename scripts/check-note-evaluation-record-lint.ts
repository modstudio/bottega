import type { NoteClassPass } from '../hub/src/note-classification.ts'
import type { NoteCurationResult } from '../hub/src/note-curation.ts'
import type { NoteProposal, RankedClass } from '../hub/src/note-curation-decisions.ts'
import {
  type EvaluationNote,
  type NoteEvaluationResult,
  noteEvaluationBody,
} from '../hub/src/note-evaluation.ts'
import { appendCurationRecord, noteEvaluationBaseData } from '../hub/src/note-evaluation-record.ts'
import { lintStoredDoc } from '../orchestrator/src/doc/doc-lint-adapter.ts'

const hostile = [
  '2026-11-26 DEV-9999 bun run script-that-does-not-exist',
  '`hub/src/x.ts:12` [missing](missing.md)',
  '```',
  '~~~',
].join('\n')

const notes: EvaluationNote[] = [
  {
    record_id: '01990000-0000-7000-8000-000000003281',
    label: 'alpha#1',
    project: 'alpha',
    text: hostile,
    created_at: '2026-01-01',
  },
  {
    record_id: '01990000-0000-7000-8000-000000003282',
    label: 'alpha#2',
    project: 'alpha',
    text: `Second ${hostile}`,
    created_at: '2026-01-01',
  },
]

/** Builds a complete record covering hostile note, answer, curator, proposal, and seed text. */
function hostileNoteEvaluationRecord(): string {
  const result: NoteEvaluationResult = {
    generatedPairs: 1,
    pairsAsked: 1,
    answeredPairs: 0,
    reusedAnswers: 0,
    newAnswers: 0,
    answerFailure: hostile,
    recall: { produced: 1, total: 2, unreadable: 0, fraction: 0.5 },
    clusters: [{ notes, meanProbability: 0.9 }],
  }
  const proposals: NoteProposal[] = [
    {
      label: notes[0]!.label,
      class: { proposed: { name: hostile, definition: hostile } },
      duplicate_of: null,
      still_holds: 'yes',
      reason: hostile,
      source: 'curator',
    },
  ]
  const classPass: NoteClassPass = {
    ran: false,
    status: hostile,
    answers: 0,
    proposals: [],
    remaining: notes.map((note) => ({ ...note, sightings: 1 })),
  }
  const curation: NoteCurationResult = {
    proposals,
    failedPages: [
      { page: 1, labels: notes.map(({ label }) => label), runId: null, error: hostile },
    ],
    invalidEntries: 1,
    stopped: hostile,
  }
  const ranking: RankedClass[] = [
    {
      key: hostile,
      name: hostile,
      definition: hostile,
      proposed: true,
      noteCount: 1,
      sightings: 1,
      notes: [notes[0]!.label],
    },
    {
      key: 'C5',
      name: hostile,
      definition: hostile,
      proposed: false,
      noteCount: 1,
      sightings: 1,
      notes: [notes[1]!.label],
    },
  ]
  const base = noteEvaluationBaseData(result)
  return appendCurationRecord(
    noteEvaluationBody('alpha', notes.length, '2026-11-26T19:00:00.000Z', result),
    base,
    classPass,
    curation,
    proposals,
    ranking,
  )
}

/** Returns only errors from the same stored-document lint used by doc set. */
function noteEvaluationRecordLintFindings() {
  const body = hostileNoteEvaluationRecord()
  if (body.match(/```note-evaluation-json/g)?.length !== 1)
    throw new Error('note-evaluation record must contain exactly one data fence')
  return lintStoredDoc(
    {
      scope: 'project',
      subject: 'alpha',
      slug: 'note-evaluation',
      body,
      kind: 'working',
      status: 'current',
    },
    [
      {
        name: 'alpha',
        stack: null,
        checkout: { files: [], trackedPaths: [], packageScripts: [], sourceTexts: [] },
      },
    ],
  ).filter(({ level }) => level === 'error')
}

if (import.meta.main) {
  const findings = noteEvaluationRecordLintFindings()
  for (const finding of findings) console.error(JSON.stringify(finding))
  if (findings.length) process.exit(1)
  console.log('note-evaluation record lint guard passed')
}
