import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import { typedQuestionStateIdentity } from '../../shared/typed-question/state-identity.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import { NOTE_DUPLICATE_CANDIDATES } from './note-duplicate-candidates.ts'
import { NOTE_DUPLICATE_QUESTION, notePairSubjectRef } from './note-duplicate-question.ts'
import {
  answerEvaluationPair,
  averageLinkageClusters,
  blockingRecall,
  type EvaluationNote,
  evaluateNotePairs,
  generateEvaluationPairs,
  noteEvaluationBody,
} from './note-evaluation.ts'
import { askHubTypedQuestionWithReuse } from './typed-question-service.ts'

const note = (label: string, createdAt: string, text = label): EvaluationNote => ({
  record_id: newRecordId(),
  label,
  project: 'project',
  text,
  created_at: createdAt,
})

test('generates unordered pairs in filing orientation', () => {
  const newer = note('project#2', '2026-01-02T00:00:00Z', 'shared words newer')
  const older = note('project#1', '2026-01-01T00:00:00Z', 'shared words older')
  const pairs = generateEvaluationPairs([newer, older])
  expect(pairs).toHaveLength(1)
  expect(pairs[0]).toMatchObject({
    existing: { record_id: older.record_id },
    newer: { record_id: newer.record_id },
    subjectRef: notePairSubjectRef(older.record_id, newer.text),
  })
})

test('reuses an exact recorded answer without asking again', async () => {
  const older = note('project#1', '2026-01-01T00:00:00Z', 'older')
  const newer = note('project#2', '2026-01-02T00:00:00Z', 'newer')
  const pair = generateEvaluationPairs([older, newer])[0]!
  const state = { existing: older.text, new: newer.text }
  writeTransaction((database) => {
    database
      .query(
        `INSERT INTO typed_question_answer
         (record_id,question_id,question_version,subject_kind,subject_ref,state_sha,state_json,
          answer_json,model,input_tokens,latency_ms,error,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        newRecordId(),
        NOTE_DUPLICATE_QUESTION.id,
        NOTE_DUPLICATE_QUESTION.version,
        'note-pair',
        pair.subjectRef,
        typedQuestionStateIdentity(state),
        JSON.stringify(state),
        JSON.stringify({ noul: 0.91 }),
        'jev',
        1,
        1,
        null,
        nowIso(),
      )
  })
  const answer = await answerEvaluationPair(pair, (input) =>
    askHubTypedQuestionWithReuse(input, {
      ask: async () => {
        throw new Error('asked despite a recorded answer')
      },
      database: db,
      record: () => {
        throw new Error('recorded despite a recorded answer')
      },
    }),
  )
  expect(answer).toEqual({ probability: 0.91, reused: true })
})

test('average linkage does not turn an unasked edge chain into one cluster', () => {
  const a = note('A', '2026-01-01T00:00:00Z')
  const b = note('B', '2026-01-02T00:00:00Z')
  const c = note('C', '2026-01-03T00:00:00Z')
  const chain = [
    { existing: a, newer: b, probability: 0.9 },
    { existing: b, newer: c, probability: 0.9 },
  ]
  expect(averageLinkageClusters([a, b, c], chain)).toMatchObject([
    { notes: [{ label: 'A' }, { label: 'B' }] },
  ])
  expect(
    averageLinkageClusters([a, b, c], [...chain, { existing: a, newer: c, probability: 0.9 }])[0]
      ?.notes,
  ).toHaveLength(3)
})

function outcome(subjectRef: string, source: string): void {
  writeTransaction((database) => {
    database
      .query(
        `INSERT INTO typed_question_outcome
         (record_id,question_id,question_version,subject_ref,label,source,created_at)
         VALUES (?,?,?,?,1,?,?)`,
      )
      .run(
        newRecordId(),
        NOTE_DUPLICATE_QUESTION.id,
        NOTE_DUPLICATE_QUESTION.version,
        subjectRef,
        source,
        nowIso(),
      )
  })
}

test('blocking recall includes non-actionable existing notes and excludes unreadable positives', () => {
  const older = note('project#1', '2026-01-01T00:00:00Z', 'shared stored pair older')
  const newer = note('project#2', '2026-01-02T00:00:00Z', 'shared stored pair newer')
  const included = notePairSubjectRef(older.record_id, newer.text)
  const missedExisting = note('project#3', '2026-01-03T00:00:00Z', 'leftanchor')
  const missedNewText = 'rightanchor'
  const missed = notePairSubjectRef(missedExisting.record_id, missedNewText)
  const distractors = Array.from({ length: NOTE_DUPLICATE_CANDIDATES }, (_, index) =>
    note(
      `project#${index + 4}`,
      '2026-01-04T00:00:00Z',
      `leftanchor rightanchor distractor${index}`,
    ),
  )
  outcome(included, 'same-as')
  outcome(missed, 'merge')
  outcome(notePairSubjectRef(older.record_id, 'unreadable deleted source'), 'merge')
  writeTransaction((database) => {
    database
      .query(
        `INSERT INTO note (record_id,number,project,text,anchors,created_at,last_seen_at)
         VALUES (?,1,'project',?,'[]',?,?)`,
      )
      .run(older.record_id, older.text, older.created_at, older.created_at)
    database
      .query(
        `INSERT INTO typed_question_answer
         (record_id,question_id,question_version,subject_kind,subject_ref,state_sha,state_json,
          answer_json,model,input_tokens,latency_ms,error,created_at)
         VALUES (?,?,?,?,?,?,?,NULL,'jev',NULL,1,NULL,?)`,
      )
      .run(
        newRecordId(),
        NOTE_DUPLICATE_QUESTION.id,
        NOTE_DUPLICATE_QUESTION.version,
        'note-pair',
        included,
        typedQuestionStateIdentity({ existing: older.text, new: newer.text }),
        JSON.stringify({ existing: older.text, new: newer.text }),
        nowIso(),
      )
    database
      .query(
        `INSERT INTO typed_question_answer
         (record_id,question_id,question_version,subject_kind,subject_ref,state_sha,state_json,
          answer_json,model,input_tokens,latency_ms,error,created_at)
         VALUES (?,?,?,?,?,?,?,NULL,'jev',NULL,1,NULL,?)`,
      )
      .run(
        newRecordId(),
        NOTE_DUPLICATE_QUESTION.id,
        NOTE_DUPLICATE_QUESTION.version,
        'note-pair',
        missed,
        typedQuestionStateIdentity({ existing: missedExisting.text, new: missedNewText }),
        JSON.stringify({ existing: missedExisting.text, new: missedNewText }),
        nowIso(),
      )
  })
  const actionableNotes = [missedExisting, ...distractors]
  const allProjectNotes = [older, ...actionableNotes]
  expect(blockingRecall(db(), 'project', actionableNotes, allProjectNotes)).toEqual({
    produced: 1,
    total: 2,
    unreadable: 1,
  })
})

test('pair generation and sparse clustering handle 1,500 notes', () => {
  const notes = Array.from({ length: 1_500 }, (_, index) => ({
    record_id: `note-${index.toString().padStart(4, '0')}`,
    label: `project#${index + 1}`,
    project: 'project',
    text: `shared evaluation vocabulary unique${index}`,
    created_at: '2026-01-01T00:00:00Z',
  }))
  const pairs = generateEvaluationPairs(notes)
  expect(pairs.length).toBeGreaterThan(0)
  const probabilities = Array.from({ length: 750 }, (_, index) => ({
    existing: notes[index * 2]!,
    newer: notes[index * 2 + 1]!,
    probability: 0.9,
  }))
  expect(averageLinkageClusters(notes, probabilities)).toHaveLength(750)
})

test('missing credential obtains no answers and leaves notes unchanged', async () => {
  const notes = [
    note('project#1', '2026-01-01T00:00:00Z'),
    note('project#2', '2026-01-02T00:00:00Z'),
  ]
  const before = structuredClone(notes)
  let asks = 0
  const result = await evaluateNotePairs('project', notes, notes, {
    credential: async () => ({ available: false, reason: 'no answers obtained: missing key' }),
    answerPair: async () => {
      asks++
      return { probability: 1, reused: false }
    },
    positiveSubjects: () => ({ produced: 0, total: 2, unreadable: 2 }),
  })
  expect(result).toMatchObject({
    pairsAsked: 0,
    answeredPairs: 0,
    answerFailure: 'no answers obtained: missing key',
  })
  expect(asks).toBe(0)
  expect(notes).toEqual(before)
  const body = noteEvaluationBody('project', 'now', notes.length, result)
  expect(body).not.toContain('no duplicates')
  expect(body).toContain('2 unreadable positives excluded')
})

test('zero candidate pairs are reported without a typed-question service failure', async () => {
  const result = await evaluateNotePairs('project', [], [], {
    credential: async () => ({ available: true }),
    answerPair: async () => null,
    positiveSubjects: () => ({ produced: 0, total: 0, unreadable: 0 }),
  })
  expect(result).toMatchObject({ pairsAsked: 0, answerFailure: null })
  expect(noteEvaluationBody('project', 'now', 0, result)).toContain('No candidate pairs to ask.')
})

test('pairs asked excludes reused answers and includes failed asks', async () => {
  const notes = [
    note('project#1', '2026-01-01T00:00:00Z'),
    note('project#2', '2026-01-02T00:00:00Z'),
  ]
  const dependencies = {
    credential: async () => ({ available: true as const }),
    positiveSubjects: () => ({ produced: 0, total: 0, unreadable: 0 }),
  }
  const reused = await evaluateNotePairs('project', notes, notes, {
    ...dependencies,
    answerPair: async () => ({ probability: 0.9, reused: true }),
  })
  const failed = await evaluateNotePairs('project', notes, notes, {
    ...dependencies,
    answerPair: async () => null,
  })

  expect(reused).toMatchObject({ generatedPairs: 1, pairsAsked: 0, reusedAnswers: 1 })
  expect(failed).toMatchObject({ generatedPairs: 1, pairsAsked: 1, answeredPairs: 0 })
})
