import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../../test/preload.ts'
import {
  chooseProfileRequest,
  foldGooseContextProfile,
  gooseSessionContextProfile,
} from './transport-goose-context-profile.ts'

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

test('profiles compactions for only the requested Goose session', () => {
  const gooseDir = join(dir, 'goose-session-context-profile')
  mkdirSync(join(gooseDir, 'sessions'), { recursive: true })
  const database = new Database(join(gooseDir, 'sessions', 'sessions.db'))
  database.run(
    'CREATE TABLE usage_ledger (session_id TEXT, is_compaction INTEGER, cache_read_tokens INTEGER)',
  )
  database.run("INSERT INTO usage_ledger VALUES ('target', 1, 12), ('other', 1, 30)")
  database.close()

  expect(gooseSessionContextProfile(gooseDir, 'target')).toMatchObject({
    compactions: 1,
    cacheReadTokens: 12,
  })
})
