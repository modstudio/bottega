import { expect, test } from 'bun:test'
import { readerMayCallTool, writerMayCallTool } from './mcp-reader-policy.ts'

const decision = (overrides: Partial<Parameters<typeof readerMayCallTool>[0]> = {}) =>
  readerMayCallTool({
    name: 'read',
    readOnlyHint: undefined,
    server: 'project',
    projectServer: 'project',
    registeredTools: [],
    ...overrides,
  })

test('reader tool decision accepts register names on any server', () => {
  expect(decision({ server: 'other', registeredTools: ['read'] })).toBeTrue()
})

test('reader tool decision accepts annotations only from the project own server', () => {
  expect(decision({ readOnlyHint: true })).toBeTrue()
  expect(decision({ server: 'other', readOnlyHint: true })).toBeFalse()
})

test('reader tool decision refuses absent and false annotations', () => {
  expect(decision()).toBeFalse()
  expect(decision({ readOnlyHint: false })).toBeFalse()
})

test('writer tool decision admits exact register names and ignores read-only annotations', () => {
  const facts = {
    name: 'query-database',
    readOnlyHint: true,
    server: 'project',
    projectServer: 'project',
    registeredTools: [] as string[],
  }
  expect(writerMayCallTool(facts)).toBeFalse()
  expect(writerMayCallTool({ ...facts, registeredTools: ['query-database'] })).toBeTrue()
  expect(readerMayCallTool(facts)).toBeTrue()
})
