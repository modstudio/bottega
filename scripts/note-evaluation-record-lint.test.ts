import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../hub/src/migrations.ts'
import type { NoteClassPass } from '../hub/src/note-classification.ts'
import type { NoteCurationResult } from '../hub/src/note-curation.ts'
import type { NoteProposal, RankedClass } from '../hub/src/note-curation-decisions.ts'
import { type NoteEvaluationResult, noteEvaluationBody } from '../hub/src/note-evaluation.ts'
import {
  appendCurationRecord,
  appendEvaluationRecordData,
} from '../hub/src/note-evaluation-record.ts'
import { lintStoredDoc } from '../orchestrator/src/doc/doc-lint-adapter.ts'

test('a full note evaluation record is accepted by the stored-document lint', () => {
  const database = new Database(':memory:')
  applyMigrations(database, undefined, {
    machine_id: '01990000-0000-7000-8000-000000003282',
  })
  const hostile = [
    '2026-11-26 DEV-9999 bun run script-that-does-not-exist',
    '`hub/src/x.ts:12` [missing](missing.md)',
    '```',
    '~~~',
  ].join('\n')
  const insert = database.query(
    `INSERT INTO note
     (record_id,number,project,text,anchors,sightings,created_at,last_seen_at)
     VALUES (?,?,?,?, '[]', 1, '2026-01-01', '2026-01-01')`,
  )
  insert.run('01990000-0000-7000-8000-000000003281', 1, 'alpha', hostile)
  insert.run('01990000-0000-7000-8000-000000003282', 2, 'alpha', `Second ${hostile}`)
  const notes = database
    .query<
      { record_id: string; label: string; project: string; text: string; created_at: string },
      []
    >(
      `SELECT record_id, project || '#' || number label, project, text, created_at
       FROM note ORDER BY number`,
    )
    .all()
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
  ]
  const base = appendEvaluationRecordData(noteEvaluationBody('alpha', notes.length, result), result)
  const body = appendCurationRecord(base, classPass, curation, proposals, ranking)
  expect(body.match(/```note-evaluation-json/g)).toHaveLength(1)

  const findings = lintStoredDoc(
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
  )
  database.close()

  expect(findings.filter(({ level }) => level === 'error')).toEqual([])
})
