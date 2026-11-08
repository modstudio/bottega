import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { newRecordId } from '../../shared/record-id.ts'
import { db, writeTransaction } from './db.ts'
import {
  askNoteDuplicateQuestions,
  jevOnlyDuplicateCandidates,
  NOTE_DUPLICATE_CANDIDATES,
  NOTE_DUPLICATE_QUESTION,
  noteDuplicateLabel,
  noteDuplicateQuestionCandidates,
  recordNoteDuplicateDistinct,
  recordNoteDuplicateMerge,
  recordNoteDuplicateOutcomes,
} from './note-duplicate-question.ts'

const note = (recordId: string, project: string, text: string, staleAt: string | null = null) => ({
  record_id: recordId,
  project,
  text,
  stale_at: staleAt,
})

test('ranks all non-stale project notes by duplicate score and keeps the named limit', () => {
  const notes = [
    note('other', 'other', 'alpha beta'),
    note('stale', 'project', 'alpha beta', '2026-01-01'),
    ...Array.from({ length: NOTE_DUPLICATE_CANDIDATES + 2 }, (_, index) =>
      note(String(index).padStart(2, '0'), 'project', index === 0 ? 'alpha beta' : `note ${index}`),
    ),
  ]
  const selected = noteDuplicateQuestionCandidates(notes, 'project', 'alpha beta')
  expect(selected).toHaveLength(NOTE_DUPLICATE_CANDIDATES)
  expect(selected[0]).toMatchObject({ record_id: '00', score: 1 })
  expect(selected.map((candidate) => candidate.record_id)).not.toContain('other')
  expect(selected.map((candidate) => candidate.record_id)).not.toContain('stale')
})

test('adds only Jev-only candidates at or above the threshold', () => {
  const lexical = [{ record_id: 'lexical', text: 'lexical' }]
  const asked = [
    { note: lexical[0]!, probability: 1 },
    {
      note: { record_id: 'boundary', text: 'boundary' },
      probability: NOTE_DUPLICATE_QUESTION.threshold,
    },
    {
      note: { record_id: 'below', text: 'below' },
      probability: NOTE_DUPLICATE_QUESTION.threshold - 0.01,
    },
  ]
  expect(jevOnlyDuplicateCandidates(lexical, asked)).toEqual([
    { record_id: 'boundary', text: 'boundary', probability: NOTE_DUPLICATE_QUESTION.threshold },
  ])
})

function outcome(subjectRef: string, label: boolean, source: string, createdAt: string): void {
  writeTransaction((database) => {
    database
      .query(
        `INSERT INTO typed_question_outcome
         (record_id,question_id,question_version,subject_ref,label,source,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        newRecordId(),
        NOTE_DUPLICATE_QUESTION.id,
        NOTE_DUPLICATE_QUESTION.version,
        subjectRef,
        Number(label),
        source,
        createdAt,
      )
  })
}

test('labels from the latest merge even when a later new outcome exists', () => {
  const subject = newRecordId()
  outcome(subject, true, 'merge', '2026-01-01T00:00:00Z')
  outcome(subject, false, 'new', '2026-01-02T00:00:00Z')
  expect(noteDuplicateLabel(db(), subject)).toBeTrue()
})

test('labels from the latest outcome when no merge exists and returns null without one', () => {
  const subject = newRecordId()
  outcome(subject, true, 'same-as', '2026-01-01T00:00:00Z')
  outcome(subject, false, 'new', '2026-01-02T00:00:00Z')
  expect(noteDuplicateLabel(db(), subject)).toBeFalse()
  expect(noteDuplicateLabel(db(), newRecordId())).toBeNull()
})

test('keeps the answered pairs when one ask fails', async () => {
  const notes = [note('a', 'p', 'alpha'), note('b', 'p', 'beta'), note('c', 'p', 'gamma')]
  const asked = await askNoteDuplicateQuestions(notes, 'p', 'alpha beta', async (input) =>
    input.subjectRef.startsWith('b:') ? null : { noul: 0.9 },
  )
  expect(asked.map(({ note }) => note.record_id).sort()).toEqual(['a', 'c'])
})

function seedPairs(text: string, notes: readonly (readonly [string, string])[]): string {
  const hash = createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
  writeTransaction((database) => {
    for (const [recordId, project] of notes) {
      database
        .query(
          `INSERT INTO note (record_id,number,project,text,anchors,created_at,last_seen_at)
           VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM note WHERE project=?),?,?,'[]',?,?)`,
        )
        .run(recordId, project, project, 'existing', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      database
        .query(
          `INSERT INTO typed_question_answer
           (record_id,question_id,question_version,subject_kind,subject_ref,state_sha,answer_json,
            model,input_tokens,latency_ms,error,created_at)
           VALUES (?,?,?,'note-pair',?,'state','{"noul":0.9}','jev',1,1,NULL,?)`,
        )
        .run(
          newRecordId(),
          NOTE_DUPLICATE_QUESTION.id,
          NOTE_DUPLICATE_QUESTION.version,
          `${recordId}:${hash}`,
          '2026-01-01T00:00:00Z',
        )
    }
  })
  return hash
}

test('a --new filing labels only pairs whose existing note is in its project', () => {
  const text = `repeated observation ${newRecordId()}`
  const here = newRecordId()
  const elsewhere = newRecordId()
  const hash = seedPairs(text, [
    [here, 'project-here'],
    [elsewhere, 'project-elsewhere'],
  ])
  recordNoteDuplicateOutcomes(text, 'project-here', 'new')
  expect(noteDuplicateLabel(db(), `${here}:${hash}`)).toBeFalse()
  expect(noteDuplicateLabel(db(), `${elsewhere}:${hash}`)).toBeNull()
})

test('a --same-as filing labels only the named pair as a repeat', () => {
  const text = `repeated observation ${newRecordId()}`
  const named = newRecordId()
  const sibling = newRecordId()
  const hash = seedPairs(text, [
    [named, 'project-same'],
    [sibling, 'project-same'],
  ])
  recordNoteDuplicateOutcomes(text, 'project-same', 'same-as', named)
  expect(noteDuplicateLabel(db(), `${named}:${hash}`)).toBeTrue()
  expect(noteDuplicateLabel(db(), `${sibling}:${hash}`)).toBeNull()
})

test('a merge asks an unasked pair and records only when an answer is available', async () => {
  const text = `merged observation ${newRecordId()}`
  const unasked = newRecordId()
  const hash = createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
  writeTransaction((database) => {
    database
      .query(
        `INSERT INTO note (record_id,number,project,text,anchors,created_at,last_seen_at)
         VALUES (?,1,'project-merge','existing','[]','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
      )
      .run(unasked)
  })
  expect(await recordNoteDuplicateMerge(unasked, text, async () => null)).toBeFalse()
  expect(noteDuplicateLabel(db(), `${unasked}:${hash}`)).toBeNull()
  expect(await recordNoteDuplicateMerge(unasked, text, async () => ({ noul: 0.9 }))).toBeTrue()
  expect(noteDuplicateLabel(db(), `${unasked}:${hash}`)).toBeTrue()
})

test('a filing with no refusal labels its asked pairs as not repeats until a merge says otherwise', async () => {
  const text = `fresh observation ${newRecordId()}`
  const first = newRecordId()
  const second = newRecordId()
  const hash = seedPairs(text, [
    [first, 'project-filed'],
    [second, 'project-filed'],
  ])
  recordNoteDuplicateOutcomes(text, 'project-filed', 'filed')
  await recordNoteDuplicateMerge(second, text)
  expect(noteDuplicateLabel(db(), `${first}:${hash}`)).toBeFalse()
  expect(noteDuplicateLabel(db(), `${second}:${hash}`)).toBeTrue()
})

test('distinct uses the older note as existing and outranks later inference', async () => {
  const older = newRecordId()
  const newer = newRecordId()
  const text = `newer distinct ${newRecordId()}`
  const hash = seedPairs(text, [[older, 'project-distinct']])
  writeTransaction((database) => {
    database
      .query(
        `INSERT INTO note (record_id,number,project,text,anchors,created_at,last_seen_at)
         VALUES (?,2,'project-distinct',?,'[]','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z')`,
      )
      .run(newer, text)
  })
  await recordNoteDuplicateDistinct(newer, older)
  outcome(`${older}:${hash}`, true, 'same-as', '2026-02-01T00:00:00Z')
  expect(noteDuplicateLabel(db(), `${older}:${hash}`)).toBeFalse()
})

test('distinct asks an unasked pair and records only when an answer is available', async () => {
  const older = newRecordId()
  const newer = newRecordId()
  const text = `unasked distinct ${newRecordId()}`
  const hash = createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
  writeTransaction((database) => {
    const insert = database.query(
      `INSERT INTO note (record_id,number,project,text,anchors,created_at,last_seen_at)
       VALUES (?,?,'project-distinct-unasked',?,'[]',?,?)`,
    )
    insert.run(older, 1, 'existing', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    insert.run(newer, 2, text, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')
  })
  expect(await recordNoteDuplicateDistinct(newer, older, async () => null)).toBeFalse()
  expect(noteDuplicateLabel(db(), `${older}:${hash}`)).toBeNull()
  expect(await recordNoteDuplicateDistinct(newer, older, async () => ({ noul: 0.9 }))).toBeTrue()
  expect(noteDuplicateLabel(db(), `${older}:${hash}`)).toBeFalse()
})
