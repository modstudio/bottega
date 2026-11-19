import { describe, expect, test } from 'bun:test'
import { missingWorkflowTextMessage } from './workflow-text-missing.ts'

const TOKEN = 'attached-text:11111111-1111-4111-8111-111111111111'

describe('missing workflow text message', () => {
  test('a hosted miss names the record and spaces rather than this machine', () => {
    const message = missingWorkflowTextMessage(TOKEN, 'hosted')

    expect(message.condition).toContain('in the record for your spaces')
    expect(message.condition).not.toContain('this machine')
  })
})
