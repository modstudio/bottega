import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  probeAgentResumes,
  probeAgentResumesInSandbox,
  resumeCapabilityPolicy,
} from './agent-resume-probe.ts'
import type { Agent } from './agents.ts'

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

test('the ACP resume probe uses one real-run-shaped runtime directory across both turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-resume-probe-test-'))
  try {
    const runtimeDirs: string[] = []
    const result = await probeAgentResumesInSandbox(
      {
        transport: 'acp',
        scratch: root,
        agent: { name: 'fixture', baseUrl: null } as Agent,
        environment: { ...process.env },
      },
      {
        createWorktree(path) {
          mkdirSync(path)
        },
        removeWorktree() {},
        openAskListener: () => ({ address: '127.0.0.1:43123', close() {} }),
        async resetSandbox() {},
      },
      'resume-token',
      async (turn, confinement) => {
        runtimeDirs.push(confinement.runtimeDir)
        expect(confinement.scratchDir).toBe(join(root, 'writing-run', 'scratch'))
        return turn.session
          ? {
              status: 'ok',
              output: 'resume-token',
              sessionId: turn.session,
              loadSessionAdvertised: true,
            }
          : {
              status: 'ok',
              output: 'remembered',
              sessionId: 'session-1',
              loadSessionAdvertised: true,
            }
      },
    )

    expect(result.ok).toBe(true)
    expect(runtimeDirs).toEqual([
      join(root, 'sandbox-registration-probe'),
      join(root, 'sandbox-registration-probe'),
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
