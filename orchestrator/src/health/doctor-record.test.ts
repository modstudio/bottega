import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { reportRecordDoctor, workflowHistoryParityDoctorDiagnosis } from './doctor-record.ts'

test('workflow-history parity is not run without an active hosted space', async () => {
  const lines: string[] = []
  const exitCodes: number[] = []
  let whoamiCalls = 0
  let parityCalled = false

  await reportRecordDoctor(
    {
      log: (line) => lines.push(line),
      exitCode: (code) => exitCodes.push(code),
    },
    async () => {
      whoamiCalls += 1
      return {
        user: { id: 'user-a' },
        activeSpaceId: null,
        personalSpaceId: null,
        memberships: [],
      }
    },
    async () => {
      parityCalled = true
      return { lines: [], failed: true }
    },
  )

  expect(lines.filter((line) => line.startsWith('workflow history'))).toEqual([
    'workflow history parity: not run — no active hosted space',
  ])
  expect(exitCodes).toEqual([])
  expect(whoamiCalls).toBe(1)
  expect(parityCalled).toBe(false)
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
