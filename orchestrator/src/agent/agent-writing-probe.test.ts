import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '../project/projects.ts'
import type { SandboxRuntimeConfig } from '../sandbox/sandbox.ts'
import { probeAgentWrites } from './agent-writing-probe.ts'
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
const project = { settings: {} } as Project
const launch = async (_profile: SandboxRuntimeConfig, bin: string, argv: string[]) => [bin, ...argv]

test('a confined ACP writing check passes only after the requested content is written', async () => {
  const root = scratch()
  const result = await probeAgentWrites(
    { transport: 'acp', scratch: root, project, agent },
    {
      createWorktree(path) {
        mkdirSync(path)
      },
      removeWorktree() {},
      launch,
      async callAgent(input) {
        expect(input.launch).toBe(launch)
        expect(input.profile.filesystem.allowWrite).toEqual([input.cwd, root])
        expect(input.profile.filesystem.denyWrite).toContain(join(input.cwd, '.git'))
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
    { transport: 'acp', scratch: root, project, agent },
    {
      createWorktree(path) {
        mkdirSync(path)
      },
      removeWorktree() {},
      launch,
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
    { transport: 'cli', scratch: scratch(), project: null, agent },
    {
      createWorktree() {
        calls++
      },
      removeWorktree() {
        calls++
      },
      launch,
      async callAgent() {
        calls++
        return { status: 'ok', output: '' }
      },
    },
  )
  expect(result.ok).toBeNull()
  expect(calls).toBe(0)
})
