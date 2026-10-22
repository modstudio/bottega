import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeAgentWrites, writingCapabilityPolicy } from './agent-writing-probe.ts'
import type { Agent } from './agents.ts'

const scratchDirectories: string[] = []

afterEach(() => {
  for (const path of scratchDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'agent-writing-probe-test-'))
  scratchDirectories.push(path)
  return path
}

const agent = { name: 'fixture', baseUrl: null } as Agent
const environment = { ...process.env }

const lifecyclePorts = {
  openAskListener: () => ({ address: '127.0.0.1:43123', close() {} }),
  async resetSandbox() {},
}

test('a confined ACP writing check passes only after the requested content is written', async () => {
  const root = scratch()
  const result = await probeAgentWrites(
    { transport: 'acp', scratch: root, agent, environment },
    {
      ...lifecyclePorts,
      createWorktree(path) {
        mkdirSync(path)
      },
      removeWorktree() {},
      async callAgent(input) {
        expect(input.scratchDir).toBe(join(root, 'registration-probe', 'scratch'))
        expect(input.runtimeDir).toBe(join(root, 'sandbox-registration-probe'))
        expect(input.harnessStateDir).toBe(join(input.runtimeDir, 'harness'))
        expect(input.workerHomeDir).toBe(join(input.runtimeDir, 'home'))
        expect(input.profile.filesystem.allowWrite).toEqual([
          join(root, 'writing-worktree'),
          input.scratchDir,
          input.harnessStateDir,
        ])
        expect(input.profile.filesystem.allowWrite).not.toContain(input.runtimeDir)
        expect(input.profile.filesystem.allowWrite).not.toContain(
          join(input.runtimeDir, 'checkpoint-hooks'),
        )
        writeFileSync(
          join(input.cwd, 'registration-probe-write.txt'),
          'REGISTRATION_PROBE_WRITE_OK\n',
        )
        return { status: 'ok', output: 'created' }
      },
    },
  )
  expect(result).toEqual({ ok: true, output: 'created' })
})

test('an ACP writing check fails when the requested content is absent', async () => {
  const root = scratch()
  const result = await probeAgentWrites(
    { transport: 'acp', scratch: root, agent, environment },
    {
      ...lifecyclePorts,
      createWorktree(path) {
        mkdirSync(path)
      },
      removeWorktree() {},
      async callAgent() {
        return { status: 'ok', output: 'claimed success' }
      },
    },
  )
  expect(result).toEqual({ ok: false, output: 'claimed success' })
})

test('a CLI transport is not given the writing check', async () => {
  let calls = 0
  const result = await probeAgentWrites(
    { transport: 'cli', scratch: scratch(), agent, environment },
    {
      ...lifecyclePorts,
      createWorktree() {
        calls++
      },
      removeWorktree() {
        calls++
      },
      async callAgent() {
        calls++
        return { status: 'ok', output: '' }
      },
    },
  )
  expect(result.ok).toBeNull()
  expect(calls).toBe(0)
})

test('a writing-check setup failure is observed instead of thrown', async () => {
  const result = await probeAgentWrites(
    { transport: 'acp', scratch: scratch(), agent, environment },
    {
      ...lifecyclePorts,
      createWorktree() {
        throw new Error('git init failed')
      },
      removeWorktree() {},
      async callAgent() {
        throw new Error('unreachable')
      },
    },
  )
  expect(result).toEqual({ ok: false, output: 'git init failed' })
})

test('writing capability policy requires an ACP observation but not a CLI observation', () => {
  expect(writingCapabilityPolicy('acp', true)).toEqual({
    requiresObservation: true,
    writesRepo: true,
    jobSuccess: true,
  })
  expect(writingCapabilityPolicy('acp', null)).toEqual({
    requiresObservation: true,
    writesRepo: null,
    jobSuccess: false,
  })
  expect(writingCapabilityPolicy('cli', null)).toEqual({
    requiresObservation: false,
    writesRepo: null,
    jobSuccess: true,
  })
})
