import { expect, test } from 'bun:test'
import type { ContextMomentEffect } from '../../../shared/context-moment.ts'
import { applyContextMomentEffect, type ContextMomentPorts } from './context-moment-adapter.ts'
import { ContextWriteRefusalError } from './doc-context-write.ts'

const answered: ContextMomentEffect = {
  writes: [{ kind: 'position', id: 'position-q12', source: 'q12', body: 'Use this.' }],
  drops: [{ kind: 'open-question', id: 'open-q12' }],
}

test('a failed answer write keeps its open question', async () => {
  const lines: string[] = []
  let dropped = false
  const ports = {
    revision: async () => undefined,
    set: async () => {
      throw new Error('store unavailable')
    },
    drop: async () => {
      dropped = true
      throw new Error('must not run')
    },
  } as ContextMomentPorts

  await applyContextMomentEffect(
    'DEV-2267',
    answered,
    false,
    { log: (line) => lines.push(line), error: () => {} },
    ports,
  )

  expect(dropped).toBeFalse()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('; open-q12 kept')
})

test('a context policy refusal has no retry command', async () => {
  const lines: string[] = []
  const ports = {
    revision: async () => undefined,
    set: async () => {
      throw new ContextWriteRefusalError('context item position-q12 refused: position limit')
    },
    drop: async () => {
      throw new Error('must not run')
    },
  } as ContextMomentPorts

  await applyContextMomentEffect(
    'DEV-2267',
    answered,
    false,
    { log: (line) => lines.push(line), error: () => {} },
    ports,
  )

  expect(lines).toEqual([
    'context: could not write position on DEV-2267: context item position-q12 refused: position limit; open-q12 kept',
  ])
  expect(lines[0]).not.toContain('retry:')
})

test('a missing drop is silent', async () => {
  const lines: string[] = []
  const ports = {
    revision: async () => undefined,
    set: async () => {
      throw new Error('must not run')
    },
    drop: async (input) => ({
      holder: `task:${input.task}`,
      task: input.task ?? null,
      id: input.id,
      removed: false,
    }),
  } as ContextMomentPorts

  await applyContextMomentEffect(
    'DEV-2267',
    { writes: [], drops: [{ kind: 'open-question', id: 'open-q12' }] },
    false,
    { log: (line) => lines.push(line), error: () => {} },
    ports,
  )

  expect(lines).toEqual([])
})
