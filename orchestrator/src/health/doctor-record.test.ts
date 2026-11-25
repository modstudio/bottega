import { afterEach, beforeEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RECORD_ACTIVE_SPACE_REMEDY } from '../../../shared/record-remedies.ts'
import { closeDatabaseForFixture, db, withSynchronousReadOnlyDatabase } from '../database/db.ts'
import { RECORD_SIGN_IN_REMEDY } from '../record/active-space-invariant.ts'
import {
  loadWorkflowHistoryParity,
  reportRecordDoctor,
  workflowHistoryParityDoctorDiagnosis,
} from './doctor-record.ts'

let previousRecordApiUrl: string | undefined

beforeEach(() => {
  previousRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
})

afterEach(() => {
  closeDatabaseForFixture()
  if (previousRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = previousRecordApiUrl
})

test('workflow-history parity uses a read-only handle beside a guarded hosted store', async () => {
  db()
    .query(
      "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,'2026-11-25','https://record.test')",
    )
    .run()
  closeDatabaseForFixture()
  const guarded = db()
  expect(() => guarded.query('SELECT * FROM workflow_obligation').all()).toThrow(
    /workflow_obligation is held by the hosted record/,
  )
  withSynchronousReadOnlyDatabase((handle) => {
    expect(() => handle.exec('CREATE TABLE doctor_write_probe (id TEXT)')).toThrow(/read-?only/i)
  })
  const times = [10, 10]
  const diagnosis = await workflowHistoryParityDoctorDiagnosis(
    () =>
      loadWorkflowHistoryParity(undefined, async (input) => ({
        obligationIds: input.obligationIds ?? [],
        textIds: input.textIds ?? [],
        textCopyIds: input.textCopyIds ?? [],
        questionAuditIds: input.questionAuditIds ?? [],
        questionIds: input.questionIds ?? [],
        stageIds: input.stageIds ?? [],
        flowIds: input.flowIds ?? [],
        questionAuditIdentities: [],
      })),
    () => times.shift()!,
  )

  expect(diagnosis.lines).toContain(
    'workflow history workflow_step_text: 0 local; 0 on the record — ok',
  )
  expect(diagnosis.lines).toContain('workflow history parity: pass in 0 ms')
  expect(diagnosis.failed).toBe(false)
})

test('workflow-history parity is not run without an active hosted space', async () => {
  const lines: string[] = []
  const exitCodes: number[] = []
  await reportRecordDoctor(
    {
      log: (line) => lines.push(line),
      exitCode: (code) => exitCodes.push(code),
    },
    async () => ({
      user: { id: 'user-a' },
      activeSpaceId: null,
      personalSpaceId: null,
      memberships: [],
    }),
    async () => ({ lines: [], failed: true }),
    () => false,
  )

  expect(lines.filter((line) => line.startsWith('workflow history'))).toEqual([
    'workflow history parity: not run — this store has never attached to the hosted record',
  ])
  expect(exitCodes).toEqual([])
})

const activeIdentity = {
  user: { id: 'user-a' },
  activeSpaceId: 'space-a',
  personalSpaceId: null,
  memberships: [
    {
      space_id: 'space-a',
      name: 'Alpha',
      slug: 'alpha',
      role: 'owner',
      permission: 'write',
    },
  ],
}

test('attached workflow-history parity logs a failing diagnosis and exits 1', async () => {
  const lines: string[] = []
  const exitCodes: number[] = []

  await reportRecordDoctor(
    {
      log: (line) => lines.push(line),
      exitCode: (code) => exitCodes.push(code),
    },
    async () => activeIdentity,
    async () => ({
      lines: [
        'workflow history task_flow: 1 local; 0 on the record — missing from the record',
        'workflow history parity: fail in 4 ms',
      ],
      failed: true,
    }),
    () => true,
  )

  expect(lines).toContain(
    'workflow history task_flow: 1 local; 0 on the record — missing from the record',
  )
  expect(lines).toContain('workflow history parity: fail in 4 ms')
  expect(exitCodes).toEqual([1])
})

test('attached workflow-history parity leaves the exit code unchanged when passing', async () => {
  const lines: string[] = []
  const exitCodes: number[] = []

  await reportRecordDoctor(
    {
      log: (line) => lines.push(line),
      exitCode: (code) => exitCodes.push(code),
    },
    async () => activeIdentity,
    async () => ({
      lines: ['workflow history parity: pass in 2 ms'],
      failed: false,
    }),
    () => true,
  )

  expect(lines).toContain('workflow history parity: pass in 2 ms')
  expect(exitCodes).toEqual([])
})

test('attached workflow history fails with the sign-in remedy when signed out', async () => {
  const lines: string[] = []
  const exitCodes: number[] = []

  await reportRecordDoctor(
    {
      log: (line) => lines.push(line),
      exitCode: (code) => exitCodes.push(code),
    },
    async () => {
      throw new Error(RECORD_SIGN_IN_REMEDY)
    },
    async () => ({ lines: [], failed: false }),
    () => true,
  )

  expect(lines.filter((line) => line.startsWith('workflow history'))).toEqual([
    `workflow history: could not establish: ${RECORD_SIGN_IN_REMEDY}`,
    expect.stringMatching(/^workflow history parity: fail in \d+ ms$/),
  ])
  expect(exitCodes).toEqual([1])
})

test('attached workflow history fails with the shared remedy when no space is active', async () => {
  const lines: string[] = []
  const exitCodes: number[] = []

  await reportRecordDoctor(
    {
      log: (line) => lines.push(line),
      exitCode: (code) => exitCodes.push(code),
    },
    async () => ({
      user: { id: 'user-a' },
      activeSpaceId: null,
      personalSpaceId: null,
      memberships: [],
    }),
    async () => ({ lines: [], failed: false }),
    () => true,
  )

  expect(lines.filter((line) => line.startsWith('workflow history'))).toEqual([
    `workflow history: could not establish: ${RECORD_ACTIVE_SPACE_REMEDY}`,
    expect.stringMatching(/^workflow history parity: fail in \d+ ms$/),
  ])
  expect(exitCodes).toEqual([1])
})

test('workflow-history presence read failure reports the reason, remedy, and failure timing', async () => {
  const times = [10, 17]
  const diagnosis = await workflowHistoryParityDoctorDiagnosis(
    async () => {
      throw new Error(`no record session; run \`${PLATFORM_SLUG} record sign-in\``)
    },
    () => times.shift()!,
  )

  expect(diagnosis.failed).toBe(true)
  expect(diagnosis.lines).toEqual([
    `workflow history: could not establish: no record session; run \`${PLATFORM_SLUG} record sign-in\``,
    'workflow history parity: fail in 7 ms',
  ])
})

test('workflow-history parity appends passing elapsed time', async () => {
  const times = [20, 23]
  const diagnosis = await workflowHistoryParityDoctorDiagnosis(
    async () => ({
      lines: ['workflow history task_flow: 0 local; 0 on the record — ok'],
      failed: false,
    }),
    () => times.shift()!,
  )

  expect(diagnosis.failed).toBe(false)
  expect(diagnosis.lines).toEqual([
    'workflow history task_flow: 0 local; 0 on the record — ok',
    'workflow history parity: pass in 3 ms',
  ])
})
