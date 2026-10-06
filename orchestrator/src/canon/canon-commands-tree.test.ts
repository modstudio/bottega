import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { getDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { dispatchCanonCommand } from './canon-commands.ts'

test('project canon import refuses a tree-aware broken reference before the hosted call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-import-reference-'))
  try {
    const client = createMemoryRecordApiClient()
    let hostedWrites = 0
    installRecordApiClient({
      ...client,
      importCanon: async (input) => {
        hostedWrites++
        return client.importCanon(input)
      },
    })
    spawnFixtureGitSync(['init'], { cwd: root })
    mkdirSync(join(root, '.agents/reference'), { recursive: true })
    writeFileSync(
      join(root, 'AGENTS.md'),
      'Current guidance. Read [the target](.agents/reference/target.md).\n',
    )
    writeFileSync(
      join(root, '.agents/reference/target.md'),
      '---\ndescription: Target\n---\n\nCurrent target.\n',
    )
    spawnFixtureGitSync(['add', '.'], { cwd: root })
    upsertProject({ name: 'canon-import-reference', path: root, canon: true, settings: {} })
    const values = new Map([
      ['project', 'canon-import-reference'],
      ['cwd', root],
      ['reason', 'test tree-aware refusal'],
    ])
    const output: string[] = []
    const exitCodes: number[] = []
    const presentation = {
      log: (...parts: unknown[]) => output.push(parts.join(' ')),
      exitCode: (code: number) => exitCodes.push(code),
      cwd: () => root,
    }
    const flags = {
      has: (name: string) => values.has(name),
      flag: (name: string) => values.get(name),
    }

    await dispatchCanonCommand(['canon', 'import'], flags, presentation)
    expect(hostedWrites).toBe(0)
    spawnFixtureGitSync(['rm', '-f', '.agents/reference/target.md'], { cwd: root })

    values.set('dry-run', 'true')
    await dispatchCanonCommand(['canon', 'import'], flags, presentation)
    expect(exitCodes).toEqual([1])
    expect(output).toContain('refusing canon import: introduced canon findings')
    expect(output.some((line) => line.startsWith('would import '))).toBe(false)
    values.delete('dry-run')

    await expect(dispatchCanonCommand(['canon', 'import'], flags, presentation)).rejects.toThrow(
      'canon/reference-path',
    )
    expect(hostedWrites).toBe(0)
    expect(getDoc('canon', 'canon-import-reference', '.agents/reference/target.md')).not.toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
