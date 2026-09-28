import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { upsertProject } from '../project/projects.ts'
import { selectCanonWriteTree } from './doc-canon-tree.ts'
import { docCommand } from './doc-commands.ts'
import { collectDocReferenceProjects } from './doc-lint-adapter.ts'
import { getDoc } from './docs.ts'

const fixtureRoots: string[] = []

function git(cwd: string, ...args: string[]): string {
  const result = spawnFixtureGitSync(args, { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function repository(name: string): { main: string; worktree: string } {
  const parent = mkdtempSync(join(tmpdir(), `${name}-`))
  fixtureRoots.push(parent)
  const main = join(parent, 'main')
  const worktree = join(parent, 'worktree')
  mkdirSync(main)
  git(main, 'init', '--initial-branch=main')
  git(main, 'config', 'user.email', 'fixture@example.test')
  git(main, 'config', 'user.name', 'Fixture')
  writeFileSync(join(main, 'README.md'), '# Fixture\n')
  git(main, 'add', '.')
  git(main, 'commit', '-m', 'fixture')
  git(main, 'worktree', 'add', '-b', 'feature', worktree)
  mkdirSync(join(worktree, '.github/workflows'), { recursive: true })
  writeFileSync(join(worktree, '.github/workflows/workflows-sync.yml'), 'name: Sync\n')
  git(worktree, 'add', '.')
  return { main, worktree }
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function command(args: string[], stdin = '') {
  const values = new Map<string, string>()
  const present = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    if (!args[i]?.startsWith('--')) continue
    const name = args[i]!.slice(2)
    present.add(name)
    if (args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) values.set(name, args[++i]!)
  }
  const out: string[] = []
  const err: string[] = []
  let code = 0
  try {
    await docCommand(
      args[1] ?? 'list',
      args,
      { has: (name) => present.has(name), flag: (name) => values.get(name) },
      {
        log: (...parts) => out.push(parts.join(' ')),
        error: (...parts) => err.push(parts.join(' ')),
        write: (value) => out.push(value),
        stdinText: async () => stdin,
        stdinIsTTY: false,
        cwd: () => process.cwd(),
        exitCode: (value) => {
          code = value
        },
      },
    )
  } catch (error) {
    code = 1
    err.push((error as Error).message)
  }
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const body = `---
description: Branch citation
always: true
---

# Branch citation

Read [the workflow](.github/workflows/workflows-sync.yml).
`

describe('canon command tree selection', () => {
  test('project canon references use that project even when it is unmanaged', () => {
    const subject = repository('doc-reference-subject')
    const managed = repository('doc-reference-managed')
    upsertProject({ name: 'subject', path: subject.worktree, canon: true, settings: {} })
    upsertProject({
      name: 'managed',
      path: managed.main,
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

  test('a branch-only citation requires the subject worktree named by --cwd', async () => {
    const subject = repository('doc-canon-branch')
    upsertProject({ name: 'subject', path: subject.main, canon: true, settings: {} })
    const base = [
      'doc',
      'set',
      '.agents/rules/branch-citation.md',
      '--scope',
      'canon',
      '--subject',
      'subject',
      '--title',
      'Branch citation',
      '--reason',
      'test branch citation',
    ]

    const refused = await command(base, body)
    expect(refused.code).toBe(1)
    expect(refused.out).toBe(`tree: ${subject.main}`)
    expect(refused.err).toContain('canon/reference-path')

    const accepted = await command([...base, '--cwd', subject.worktree], body)
    expect(accepted.code).toBe(0)
    expect(accepted.out).toContain(`tree: ${realpathSync(subject.worktree)}`)
    expect(accepted.err).not.toContain('is not tracked')
    expect(getDoc('canon', 'subject', '.agents/rules/branch-citation.md')).not.toBeNull()

    const revision = getDoc('canon', 'subject', '.agents/rules/branch-citation.md')!.revision!
    const removed = await command([
      'doc',
      'rm',
      '.agents/rules/branch-citation.md',
      '--scope',
      'canon',
      '--subject',
      'subject',
      '--cwd',
      subject.worktree,
      '--reason',
      'test worktree removal',
      '--expect',
      revision,
    ])
    expect(removed.code).toBe(0)
    expect(removed.out).toContain(`tree: ${realpathSync(subject.worktree)}`)
  })

  test('a --cwd from another registered project is refused with both names', () => {
    const subject = repository('doc-canon-subject')
    const other = repository('doc-canon-other')
    upsertProject({ name: 'subject', path: subject.main, canon: true, settings: {} })
    upsertProject({ name: 'other', path: other.main, canon: true, settings: {} })

    expect(() =>
      selectCanonWriteTree({ scope: 'canon', subject: 'subject', cwd: other.worktree }),
    ).toThrow('project other: canon subject is project subject')
  })
})
