import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { upsertProject } from '../project/projects.ts'
import { selectCanonWriteTree } from './doc-canon-tree.ts'

const fixtureRoots: string[] = []

function repository(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`))
  fixtureRoots.push(root)
  const init = spawnFixtureGitSync(['init'], { cwd: root })
  if (init.exitCode !== 0) throw new Error(init.stderr.toString())
  writeFileSync(join(root, 'README.md'), '# Fixture\n')
  const add = spawnFixtureGitSync(['add', '.'], { cwd: root })
  if (add.exitCode !== 0) throw new Error(add.stderr.toString())
  return root
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('a --cwd from another registered project is refused with both names', () => {
  const subject = repository('doc-canon-subject')
  const other = repository('doc-canon-other')
  upsertProject({ name: 'subject', path: subject, canon: true, settings: {} })
  upsertProject({ name: 'other', path: other, canon: true, settings: {} })

  expect(() => selectCanonWriteTree({ scope: 'canon', subject: 'subject', cwd: other })).toThrow(
    'project other: document project is subject',
  )
})
