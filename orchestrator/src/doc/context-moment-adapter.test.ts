import { expect, test } from 'bun:test'
import type { ContextMomentEffect } from './context-moment.ts'
import { applyContextMomentEffect, type ContextMomentPorts } from './context-moment-adapter.ts'
import { ContextWriteRefusalError } from './doc-context-write.ts'

const answered: ContextMomentEffect = {
  writes: [{ kind: 'position', id: 'position-q12', source: 'q12', body: 'Use this.' }],
}

test('a failed answer write reports the failure', async () => {
  const lines: string[] = []
  const ports = {
    revision: async () => undefined,
    set: async () => {
      throw new Error('store unavailable')
    },
  } as ContextMomentPorts

  await applyContextMomentEffect(
    'DEV-2267',
    null,
    answered,
    false,
    { log: (line) => lines.push(line), error: () => {} },
    ports,
  )

  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('store unavailable')
})

test('a context policy refusal has no retry command', async () => {
  const lines: string[] = []
  const ports = {
    revision: async () => undefined,
    set: async () => {
      throw new ContextWriteRefusalError('context item position-q12 refused: position limit')
    },
  } as ContextMomentPorts

  await applyContextMomentEffect(
    'DEV-2267',
    null,
    answered,
    false,
    { log: (line) => lines.push(line), error: () => {} },
    ports,
  )

  expect(lines).toEqual([
    'context: could not write position on DEV-2267: context item position-q12 refused: position limit',
  ])
  expect(lines[0]).not.toContain('retry:')
})

test('a keyless cursor ruling writes exactly once to its cursor holder', async () => {
  const selections: unknown[] = []
  const ports = {
    revision: async (selection: unknown) => {
      selections.push(selection)
      return undefined
    },
    set: async (selection: unknown) => selections.push(selection),
  } as ContextMomentPorts

  await applyContextMomentEffect(null, 'cursor-record', answered, false, undefined, ports)

  expect(selections).toHaveLength(2)
  expect(selections[1]).toEqual(
    expect.objectContaining({ cursor: 'cursor-record', kind: 'position', id: 'position-q12' }),
  )
})
