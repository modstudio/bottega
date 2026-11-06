import { expect, test } from 'bun:test'
import { chooseProfileRequest, foldGooseContextProfile } from './transport-goose-context-profile.ts'

test('folds system, tool, compaction, and cache context from plain Goose values', () => {
  const tools = [{ name: 'read', input_schema: { type: 'object' } }, { name: 'write' }]
  expect(
    foldGooseContextProfile(
      { input: { messages: [{ role: 'system', content: 'system prompt' }], tools } },
      [
        { isCompaction: 0, cacheReadTokens: 12 },
        { isCompaction: 1, cacheReadTokens: 30 },
        { isCompaction: 1, cacheReadTokens: null },
        { isCompaction: 0, cacheReadTokens: 1.5 },
      ],
    ),
  ).toEqual({
    systemChars: 13,
    toolCount: 2,
    toolSchemaChars: JSON.stringify(tools).length,
    compactions: 2,
    cacheReadTokens: 42,
  })
})

test('leaves fields null when their source is absent and returns null with no sources', () => {
  expect(foldGooseContextProfile(null, [])).toEqual({
    systemChars: null,
    toolCount: null,
    toolSchemaChars: null,
    compactions: 0,
    cacheReadTokens: 0,
  })
  expect(foldGooseContextProfile({ input: {} }, null)).toBeNull()
  expect(foldGooseContextProfile(null, null)).toBeNull()
})

test('profiles the newest request that carries tools, not a newer tool-less helper call', () => {
  const helper = { input: { messages: [{ role: 'system', content: 'title' }] } }
  const agent = { input: { messages: [{ role: 'system', content: 'agent' }], tools: [] } }
  const older = { input: { messages: [], tools: [{ name: 'old' }] } }
  expect(chooseProfileRequest([helper, agent, older])).toBe(agent)
  expect(chooseProfileRequest([helper])).toBe(helper)
  expect(chooseProfileRequest([])).toBeNull()
})
