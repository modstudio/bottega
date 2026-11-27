import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record-id.ts'
import { db, writeTransaction } from './db.ts'
import { readLiveSeedClasses, runNoteClassPass } from './note-classification.ts'
import { curateEvaluationNotes } from './note-curation.ts'
import { rankNoteClasses, type SeedClass } from './note-curation-decisions.ts'
import { evaluateNotes } from './note-evaluate.ts'
import { answerEvaluationPair, blockingRecall, evaluateNotePairs } from './note-evaluation.ts'
import { appendCurationRecord, parseCurationRecord } from './note-evaluation-record.ts'
import { listProjectSlimNotes } from './note-read.ts'
import { installProjectRegisterReader } from './project-register-reader.ts'
import { projects, refreshProjects } from './projects.ts'

const note = (label: string) => ({
  record_id: label,
  label,
  project: 'alpha',
  text: label,
  sightings: 1,
  created_at: '2026-01-01',
  number: Number(label.split('#')[1]),
  last_seen_at: '2026-01-01',
  stale_at: null,
  stale_reason: null,
  promoted_task: null,
})

test('evaluation records one ranking containing Jev and curator proposals', async () => {
  const jevNote = note('alpha#1')
  const curatorNote = note('alpha#2')
  const notes = [jevNote, curatorNote]
  const seed: SeedClass[] = [{ code: 'C1', name: 'One', definition: 'one' }]
  let recorded = ''
  let rankCalls = 0
  await evaluateNotes(
    'alpha',
    { skipCurate: false, emit: () => {} },
    {
      registeredProject: () => ({ path: '/tmp/alpha' }),
      listNotes: async () => ({ notes, total: notes.length }),
      evaluatePairs: async () => ({
        generatedPairs: 0,
        pairsAsked: 0,
        answeredPairs: 0,
        reusedAnswers: 0,
        newAnswers: 0,
        answerFailure: null,
        recall: { produced: 0, total: 0, unreadable: 0, fraction: null },
        clusters: [],
      }),
      readSeed: async () => seed,
      classPass: async () => ({
        ran: true,
        status: 'Jev class pass obtained 1/2 answers',
        answers: 1,
        proposals: [
          {
            label: jevNote.label,
            class: { seed: 'C1' },
            duplicate_of: null,
            still_holds: 'unsure',
            reason: 'confident',
            source: 'jev',
          },
        ],
        remaining: [curatorNote],
      }),
      curate: async () => ({
        proposals: [
          {
            label: curatorNote.label,
            class: { proposed: { name: 'Two', definition: 'two' } },
            duplicate_of: null,
            still_holds: 'yes',
            reason: 'fit',
            source: 'curator',
          },
        ],
        failedPages: [],
        invalidEntries: 0,
        stopped: null,
      }),
      rank: (...args) => {
        rankCalls++
        return rankNoteClasses(...args)
      },
      appendRecord: appendCurationRecord,
      writeRecord: async (_project, body) => {
        recorded = body
        return {} as never
      },
    },
  )
  expect(rankCalls).toBe(1)
  expect(
    parseCurationRecord(recorded)
      ?.ranking.flatMap((item) => item.notes)
      .sort(),
  ).toEqual(['alpha#1', 'alpha#2'])
})

test('evaluation emits the curation stop reason before a record write refusal', async () => {
  const stop = 'curation refused for DEV-9999 on 2026-11-26'
  let emitted = ''
  await expect(
    evaluateNotes(
      'alpha',
      { skipCurate: false, emit: (summary) => (emitted = summary) },
      {
        registeredProject: () => ({ path: '/tmp/alpha' }),
        listNotes: async () => ({ notes: [note('alpha#1')], total: 1 }),
        evaluatePairs: async () => ({
          generatedPairs: 0,
          pairsAsked: 0,
          answeredPairs: 0,
          reusedAnswers: 0,
          newAnswers: 0,
          answerFailure: null,
          recall: { produced: 0, total: 0, unreadable: 0, fraction: null },
          clusters: [],
        }),
        readSeed: async () => [],
        classPass: async (notes) => ({
          ran: false,
          status: 'Jev class pass skipped',
          answers: 0,
          proposals: [],
          remaining: [...notes],
        }),
        curate: async () => ({
          proposals: [],
          failedPages: [{ page: 1, labels: ['alpha#1'], runId: null, error: stop }],
          invalidEntries: 0,
          stopped: stop,
        }),
        rank: () => [],
        appendRecord: appendCurationRecord,
        writeRecord: async () => {
          expect(emitted).toContain(stop)
          throw new Error('doc lint refused the record')
        },
      },
    ),
  ).rejects.toThrow('doc lint refused the record')
})

test('evaluation leaves stored notes and task rows unchanged while producing proposals', async () => {
  const project = `note-evaluate-${newRecordId()}`
  const originalProjects = projects()
  const projectRecordId = newRecordId()
  const bottegaRecordId = newRecordId()
  installProjectRegisterReader(() => [
    ...originalProjects,
    {
      record_id: projectRecordId,
      name: project,
      path: `/fixtures/repos/${project}`,
      stack: null,
      canon: true,
      repository: true,
      settings: {},
    },
    {
      record_id: bottegaRecordId,
      name: PLATFORM_SLUG,
      path: `/fixtures/repos/${PLATFORM_SLUG}`,
      stack: null,
      canon: true,
      repository: true,
      settings: {},
    },
  ])
  refreshProjects()

  const noteIds = Array.from({ length: 5 }, () => newRecordId())
  const epicId = newRecordId()
  const classCodes = ['C1', 'C2', 'C4', 'C5', 'C6', 'C7']
  writeTransaction((database) => {
    const insertNote = database.query(
      `INSERT INTO note
       (record_id,number,project,project_record_id,text,anchors,sightings,created_at,last_seen_at,
        stale_at,stale_reason,promoted_task)
       VALUES (?,?,?,?,?,'[]',?,?,?,?,?,?)`,
    )
    const notes = [
      { sightings: 3, staleAt: null, staleReason: null, promotedTask: null },
      { sightings: 2, staleAt: null, staleReason: null, promotedTask: null },
      { sightings: 1, staleAt: null, staleReason: null, promotedTask: null },
      {
        sightings: 4,
        staleAt: '2026-02-01T00:00:00.000Z',
        staleReason: 'dropped: fixed',
        promotedTask: null,
      },
      { sightings: 5, staleAt: null, staleReason: null, promotedTask: 'DEV-2686' },
    ]
    notes.forEach((stored, index) => {
      insertNote.run(
        noteIds[index]!,
        index + 1,
        project,
        projectRecordId,
        `shared evaluation note ${index + 1}`,
        stored.sightings,
        `2026-01-0${index + 1}T00:00:00.000Z`,
        `2026-01-0${index + 1}T00:00:00.000Z`,
        stored.staleAt,
        stored.staleReason,
        stored.promotedTask,
      )
    })

    database
      .query(
        `INSERT INTO task
         (record_id,key,project,title,status,status_category,source,first_seen,last_seen)
         VALUES (?, 'DEV-2079', ?, 'Class epic', 'open', 'open', 'local', '2026-01-01', '2026-01-01')`,
      )
      .run(epicId, PLATFORM_SLUG)
    const insertClass = database.query(
      `INSERT INTO task
       (record_id,key,project,title,status,status_category,parent_key,parent_record_id,body,
        source,first_seen,last_seen)
       VALUES (?,?,?,?, 'open', 'open', 'DEV-2079', ?, ?, 'local', '2026-01-01', '2026-01-01')`,
    )
    classCodes.forEach((code, index) => {
      insertClass.run(
        newRecordId(),
        `DEV-${3000 + index}`,
        PLATFORM_SLUG,
        `Class ${code}: Class ${code}`,
        epicId,
        `Definition ${code}`,
      )
    })
  })

  const noteRows = () =>
    db()
      .query(
        `SELECT text,sightings,stale_at,stale_reason,promoted_task,promoted_task_record_id
         FROM note WHERE project=? ORDER BY number`,
      )
      .all(project)
  const taskRows = () =>
    db()
      .query(
        `SELECT record_id id,status,parent_key parent,title
         FROM task ORDER BY record_id`,
      )
      .all()
  const beforeNotes = noteRows()
  const beforeTasks = taskRows()
  let recorded = ''
  let dispatches = 0

  try {
    await evaluateNotes(
      project,
      { skipCurate: false, emit: () => {} },
      {
        registeredProject: (name) =>
          projects().find((candidate) => candidate.name === name) ?? null,
        listNotes: listProjectSlimNotes,
        evaluatePairs: (name, actionable, all) =>
          evaluateNotePairs(name, actionable, all, {
            credential: async () => ({ available: true }),
            answerPair: (pair) =>
              answerEvaluationPair(pair, async () => ({
                answer: { noul: 0.1 },
                reused: false,
              })),
            positiveSubjects: (candidateProject, candidateActionable, candidateAll) =>
              blockingRecall(db(), candidateProject, candidateActionable, candidateAll),
          }),
        readSeed: readLiveSeedClasses,
        classPass: (notes, seed) =>
          runNoteClassPass(notes, seed, {
            credential: async () => ({ available: true }),
            ask: async ({ subjectRef }) => ({
              answer:
                subjectRef === noteIds[0]
                  ? {
                      choice: 'C1' as const,
                      confidence: 0.95,
                      probabilities: { C1: 0.95 } as Record<string, number>,
                    }
                  : {
                      choice: 'none' as const,
                      confidence: 0.95,
                      probabilities: { none: 0.95 } as Record<string, number>,
                    },
              reused: false,
            }),
          }),
        curate: (cwd, notes, clusters, seed) =>
          curateEvaluationNotes(cwd, notes, clusters, seed, async () => {
            dispatches++
            const labels = notes.map(({ label }) => label)
            return {
              runId: 'r1',
              reply: {
                proposals: labels.map((label, index) => ({
                  label,
                  class: { proposed: { name: 'Proposed class', definition: 'A proposal' } },
                  duplicate_of: index === 0 ? labels[1]! : null,
                  still_holds: 'yes' as const,
                  reason: 'curator proposal',
                })),
              },
            }
          }),
        rank: rankNoteClasses,
        appendRecord: appendCurationRecord,
        writeRecord: async (_name, body) => {
          recorded = body
          return {} as never
        },
      },
    )

    expect(noteRows()).toEqual(beforeNotes)
    expect(taskRows()).toEqual(beforeTasks)
    expect(taskRows()).toHaveLength(beforeTasks.length)
    expect(dispatches).toBe(1)
    expect(parseCurationRecord(recorded)?.ranking.length).toBeGreaterThan(0)
  } finally {
    installProjectRegisterReader(() => originalProjects)
    refreshProjects()
  }
})
