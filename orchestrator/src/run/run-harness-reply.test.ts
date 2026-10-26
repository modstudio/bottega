import { expect, test } from 'bun:test'
import { resolveReplyDialect } from '../contract/contract.ts'
import { job } from '../jobs/jobs.ts'
import { decideHarnessReply } from './run-harness-reply.ts'

const dialect = resolveReplyDialect(job('implement'))
const reply = (status: 'done' | 'asking') =>
  JSON.stringify({
    status,
    summary: 'summary',
    files_changed: null,
    change_guide: null,
    questions:
      status === 'asking'
        ? [
            {
              question: 'Which?',
              options: null,
              recommendation: null,
              why: 'It changes the implementation.',
            },
          ]
        : null,
    deviations: null,
    blockers: null,
    tests: null,
  })

test('harness finish accepts a valid done reply', () => {
  expect(decideHarnessReply(reply('done'), dialect, true).status).toBe('ok')
})

test('harness finish preserves a blocked reply as asking', () => {
  expect(decideHarnessReply(reply('asking'), dialect, true).status).toBe('asking')
})

test('harness finish fails a missing reply', () => {
  expect(decideHarnessReply(null, dialect, true).status).toBe('failed')
})

test('harness finish accepts a schema-valid non-writing reader reply', () => {
  const readerDialect = resolveReplyDialect(job('understand'))
  const readerReply = JSON.stringify({
    deliverables: [],
    narrative: 'Survey complete.',
    files_written: null,
  })
  expect(decideHarnessReply(readerReply, readerDialect, false).status).toBe('ok')
})
