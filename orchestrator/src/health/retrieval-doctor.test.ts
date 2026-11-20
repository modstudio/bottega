import { expect, test } from 'bun:test'
import {
  reportRetrievalDoctor,
  retrievalDoctorDecision,
  retrievalIsConfigured,
} from './retrieval-doctor.ts'

test('retrieval doctor is informational until configured and fails when configured but down', async () => {
  expect(retrievalIsConfigured('', false)).toBe(false)
  expect(retrievalIsConfigured('http://model-host/v1', false)).toBe(true)
  expect(retrievalIsConfigured('', true)).toBe(true)
  expect(retrievalDoctorDecision(false)).toEqual({
    lines: ['retrieval  not configured (optional)'],
    failed: false,
  })

  const lines: string[] = []
  const exits: number[] = []
  await reportRetrievalDoctor(
    true,
    { log: (line) => lines.push(line), exitCode: (code) => exits.push(code) },
    async () => ({ stdout: 'embedding unreachable', stderr: '', exitCode: 1 }),
  )
  expect(lines).toEqual([
    'retrieval endpoints (optional; search_code and doc search unavailable)',
    '  embedding unreachable',
  ])
  expect(exits).toEqual([1])
})
