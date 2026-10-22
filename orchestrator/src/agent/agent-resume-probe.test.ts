import { expect, test } from 'bun:test'
import { probeAgentResumes, resumeCapabilityPolicy } from './agent-resume-probe.ts'

test('resume capability policy observes ACP and preserves CLI declarations', () => {
  expect(resumeCapabilityPolicy('acp', true)).toEqual({ resumable: true, jobSuccess: true })
  expect(resumeCapabilityPolicy('acp', false)).toEqual({ resumable: false, jobSuccess: false })
  expect(resumeCapabilityPolicy('cli', null)).toEqual({ resumable: null, jobSuccess: true })
})

test('an ACP agent that advertises loadSession and returns the token passes', async () => {
  const sessions: Array<string | undefined> = []
  const result = await probeAgentResumes('acp', 'resume-token', async (input) => {
    sessions.push(input.session)
    return input.session
      ? {
          status: 'ok',
          output: 'resume-token',
          sessionId: input.session,
          loadSessionAdvertised: true,
        }
      : { status: 'ok', output: 'remembered', sessionId: 'session-1', loadSessionAdvertised: true }
  })
  expect(result.ok).toBe(true)
  expect(sessions).toEqual([undefined, 'session-1'])
})

test('an ACP agent without loadSession fails without a second process', async () => {
  let calls = 0
  const result = await probeAgentResumes('acp', 'resume-token', async () => {
    calls++
    return {
      status: 'ok',
      output: 'remembered',
      sessionId: 'session-1',
      loadSessionAdvertised: false,
    }
  })
  expect(result).toEqual({ ok: false, output: 'ACP initialize did not advertise loadSession' })
  expect(calls).toBe(1)
})

test('an ACP agent that loads but loses the token fails', async () => {
  const result = await probeAgentResumes('acp', 'resume-token', async (input) =>
    input.session
      ? {
          status: 'ok',
          output: 'I do not know',
          sessionId: input.session,
          loadSessionAdvertised: true,
        }
      : { status: 'ok', output: 'remembered', sessionId: 'session-1', loadSessionAdvertised: true },
  )
  expect(result.ok).toBe(false)
})

test('a CLI agent does not run the resume check', async () => {
  let called = false
  const result = await probeAgentResumes('cli', 'resume-token', async () => {
    called = true
    throw new Error('must not run')
  })
  expect(result.ok).toBeNull()
  expect(called).toBe(false)
})
