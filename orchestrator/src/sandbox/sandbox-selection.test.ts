import { expect, test } from 'bun:test'
import { classify, NOT_EVIDENCE } from '../failure/failure.ts'
import { isWritingAcpRun } from './sandbox.ts'

test('the writing ACP decision requires both ACP and repository writes', () => {
  expect(isWritingAcpRun('acp', true)).toBe(true)
  expect(isWritingAcpRun('acp', false)).toBe(false)
  expect(isWritingAcpRun('cli', true)).toBe(false)
})

test('sandbox denial classification is conditioned on srt and accepts every absolute path', () => {
  const hostDenial = 'cat: /Users/operator/.ssh/orch-sentinel: Operation not permitted'
  expect(classify(hostDenial, 1, false, 'host')).toBe('other')
  expect(classify('cat: /shared/x.secret: Operation not permitted', 1, false, 'srt')).toBe(
    'sandbox_denied',
  )
  expect(classify('cat: /var/run/docker.sock: Operation not permitted', 1, false, 'srt')).toBe(
    'sandbox_denied',
  )
  expect(NOT_EVIDENCE).toContain('sandbox_denied')
})
