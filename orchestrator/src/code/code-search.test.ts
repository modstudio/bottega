import { expect, test } from 'bun:test'
import type { Project } from '../project/projects.ts'
import { searchProjectCode } from './code-search.ts'

const project = (enabled: boolean): Project => ({
  id: 1,
  name: 'fixture',
  path: '/projects/fixture',
  stack: null,
  canon: true,
  retiredAt: null,
  settings: { search: { code: enabled } },
})

test('code search refuses before spawning when the project has not opted in', async () => {
  let ran = false
  await expect(
    searchProjectCode(
      project(false),
      '/projects/fixture/.claude/worktrees/one',
      'meaning',
      5,
      async () => {
        ran = true
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    ),
  ).rejects.toThrow('settings.search.code')
  expect(ran).toBe(false)
})

test('code search parses the shared result contract', async () => {
  const output = {
    query: 'meaning',
    k: 1,
    contract: { model: 'model', dimension: 1024, instructionVersion: 'doc-search-v1' },
    refresh: { embedded: 1, deleted: 0, unchanged: 0, stale: 0, pruned: 0 },
    results: [
      {
        project: 'fixture',
        path: 'src/answer.ts',
        startLine: 4,
        endLine: 12,
        snippet: 'answer',
        truncated: false,
        embeddingScore: 0.7,
        rerankScore: 0.9,
      },
    ],
  }
  const result = await searchProjectCode(
    project(true),
    '/projects/fixture/.claude/worktrees/one',
    'meaning',
    1,
    async () => ({
      stdout: JSON.stringify(output),
      stderr: '',
      exitCode: 0,
    }),
  )
  expect(result).toEqual(output)
})
