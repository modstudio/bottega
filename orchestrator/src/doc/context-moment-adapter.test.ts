import { expect, test } from 'bun:test'
import { contextMomentEffect } from './context-moment.ts'
import { applyContextMomentEffect, type ContextMomentPorts } from './context-moment-adapter.ts'
import { ContextWriteRefusalError } from './doc-context-write.ts'

const answered = contextMomentEffect({
  holder: { kind: 'task', value: 'DEV-2267' },
  questionId: 12,
  text: 'Use this.',
})

test('a failed answer write reports the failure', async () => {
  const lines: string[] = []
  const ports = {
    revision: async () => undefined,
    set: async () => {
      throw new Error('store unavailable')
    },
  } as ContextMomentPorts

  await applyContextMomentEffect(
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

test('a successful answer write reports its cursor warning after the write', async () => {
  const lines: string[] = []
  const warning = 'warning: no open workflow cursor carries DEV-2267 or its descendants'
  const ports = {
    revision: async () => undefined,
    set: async () => ({ warning }) as Awaited<ReturnType<ContextMomentPorts['set']>>,
  } as ContextMomentPorts

  await applyContextMomentEffect(
    answered,
    false,
    { log: (line) => lines.push(line), error: () => {} },
    ports,
  )

  expect(lines).toEqual(['context: wrote position position-q12 on DEV-2267', warning])
})

test('a keyless cursor ruling writes exactly once to its cursor holder', async () => {
  const selections: unknown[] = []
  const ports = {
    revision: async (selection: unknown) => {
      selections.push(selection)
      return undefined
    },
    set: async (selection: unknown) => {
      selections.push(selection)
      return {} as Awaited<ReturnType<ContextMomentPorts['set']>>
    },
  } as ContextMomentPorts

  const cursorEffect = contextMomentEffect({
    holder: { kind: 'cursor', value: 'cursor-record' },
    questionId: 12,
    text: 'Use this.',
  })
  await applyContextMomentEffect(cursorEffect, false, undefined, ports)

  expect(selections).toHaveLength(2)
  expect(selections[1]).toEqual(
    expect.objectContaining({ cursor: 'cursor-record', kind: 'position', id: 'position-q12' }),
  )
})
