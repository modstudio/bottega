import { describe, expect, test } from 'bun:test'
import type { EnforcedContext } from './canon-edit-guard.ts'
import { type CanonEditHookPorts, handleCanonEditHook } from './canon-edit-hook-handler.ts'

const context: EnforcedContext = {
  path: '.agents/contexts/x.md',
  description: 'Guarded source',
  globs: ['src/**'],
}
const payload = JSON.stringify({
  session_id: 'session',
  transcript_path: '/transcript',
  cwd: '/repo',
  tool_name: 'Edit',
  tool_input: { file_path: '/repo/src/x.ts' },
})
const ports = (overrides: Partial<CanonEditHookPorts> = {}): CanonEditHookPorts => ({
  readContexts: () => [context],
  readTranscript: () => [],
  readRegistered: () => true,
  readWatermark: () => 0,
  writeWatermark: () => {},
  ...overrides,
})
const handled = (body: string, overrides: Partial<CanonEditHookPorts> = {}) =>
  handleCanonEditHook({
    payload: body,
    compact: false,
    projectRoot: '/repo',
    ports: ports(overrides),
  })
const expectFailOpen = async (outcome: Awaited<ReturnType<typeof handled>>, phrase: string) => {
  expect(outcome.stdout).toBeUndefined()
  expect(outcome.warning).toContain('allowed unchecked')
  expect(outcome.warning).toContain(phrase)
  expect(outcome.warning?.includes('\n')).toBe(false)
}

describe('canon edit hook fail-open handling', () => {
  test('malformed payload', async () => expectFailOpen(await handled('{'), 'payload is malformed'))

  test('unreadable contexts', async () => {
    await expectFailOpen(
      await handled(payload, {
        readContexts: () => {
          throw new Error('no contexts')
        },
      }),
      'contexts are unreadable',
    )
  })

  test('unreadable register', async () => {
    await expectFailOpen(
      await handled(payload, {
        readRegistered: () => {
          throw new Error('no register')
        },
      }),
      'register is unreadable',
    )
  })

  test('unreadable transcript', async () => {
    await expectFailOpen(
      await handled(payload, {
        readTranscript: () => {
          throw new Error('no transcript')
        },
      }),
      'transcript is unreadable',
    )
  })

  test('watermark I/O failure', async () => {
    await expectFailOpen(
      await handled(payload, {
        readWatermark: () => {
          throw new Error('no state')
        },
      }),
      'watermark state is unreadable',
    )
  })

  test('unexpected exception', async () => {
    const broken = new Proxy([context], {
      get(target, property, receiver) {
        if (property === 'filter') throw new Error('surprise')
        return Reflect.get(target, property, receiver)
      },
    })
    await expectFailOpen(
      await handled(payload, { readContexts: () => broken }),
      'unexpected hook failure: surprise',
    )
  })

  test('read-only Bash returns before constructing adapter ports', async () => {
    let loaded = false
    const bash = JSON.stringify({
      session_id: 'session',
      transcript_path: '/transcript',
      cwd: '/repo',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    })
    expect(
      await handleCanonEditHook({
        payload: bash,
        compact: false,
        projectRoot: '/repo',
        ports: () => {
          loaded = true
          return ports()
        },
      }),
    ).toEqual({})
    expect(loaded).toBe(false)
  })
})
