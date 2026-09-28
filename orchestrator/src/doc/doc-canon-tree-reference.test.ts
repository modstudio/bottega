import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { upsertProject } from '../project/projects.ts'
import { collectDocReferenceProjects } from './doc-lint-adapter.ts'

const fixtureRoots: string[] = []

function trackedRepository(name: string, branchOnlyPath: boolean): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`))
  fixtureRoots.push(root)
  const init = spawnFixtureGitSync(['init'], { cwd: root })
  if (init.exitCode !== 0) throw new Error(init.stderr.toString())
  writeFileSync(join(root, 'README.md'), '# Fixture\n')
  if (branchOnlyPath) {
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/workflows-sync.yml'), 'name: Sync\n')
  }
  const add = spawnFixtureGitSync(['add', '.'], { cwd: root })
  if (add.exitCode !== 0) throw new Error(add.stderr.toString())
  const commit = spawnFixtureGitSync(
    ['-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '-m', 'fixture'],
    { cwd: root },
  )
  if (commit.exitCode !== 0) throw new Error(commit.stderr.toString())
  return root
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('project canon references use that project even when it is unmanaged', () => {
  const subject = trackedRepository('doc-reference-subject', true)
  const managed = trackedRepository('doc-reference-managed', false)
  upsertProject({ name: 'subject', path: subject, canon: true, settings: {} })
  upsertProject({
    name: 'managed',
    path: managed,
    canon: true,
    settings: { managedContext: true },
  })

  const subjectReferences = collectDocReferenceProjects({ scope: 'canon', subject: 'subject' })
  expect(subjectReferences.map(({ name }) => name)).toEqual(['subject'])
  expect(subjectReferences[0]?.checkout?.trackedPaths).toContain(
    '.github/workflows/workflows-sync.yml',
  )
  const globalReferences = collectDocReferenceProjects({ scope: 'canon', subject: null })
  expect(globalReferences.map(({ name }) => name)).toEqual(['managed'])
  expect(globalReferences[0]?.checkout?.trackedPaths).not.toContain(
    '.github/workflows/workflows-sync.yml',
  )
  expect(
    collectDocReferenceProjects({ scope: 'canon', subject: null, owner: 'user' })
      .map(({ name }) => name)
      .sort(),
  ).toEqual(['managed', 'subject'])
})
