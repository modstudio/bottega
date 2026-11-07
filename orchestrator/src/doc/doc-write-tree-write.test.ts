import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { collectCanonLintInput } from '../canon/canon-files.ts'
import { projectByName, upsertProject } from '../project/projects.ts'
import { docCommand } from './doc-commands.ts'
import { canonRemovalRefusal } from './doc-write-allowed.ts'
import { selectDocWriteTree, withDocWriteTreeRemedy } from './doc-write-tree.ts'
import { getDoc } from './docs.ts'

let fixtureRoot: string | null = null

function git(cwd: string, ...args: string[]): void {
  const result = spawnFixtureGitSync(args, { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function repository(): { main: string; worktree: string } {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'doc-canon-branch-'))
  const main = join(fixtureRoot, 'main')
  const worktree = join(fixtureRoot, 'worktree')
  mkdirSync(main)
  git(main, 'init', '--initial-branch=main')
  writeFileSync(join(main, 'README.md'), '# Fixture\n')
  git(main, 'add', '.')
  git(
    main,
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'user.name=Fixture',
    'commit',
    '-m',
    'fixture',
  )
  git(main, 'worktree', 'add', '-b', 'feature', worktree)
  mkdirSync(join(worktree, '.github/workflows'), { recursive: true })
  writeFileSync(join(worktree, '.github/workflows/workflows-sync.yml'), 'name: Sync\n')
  git(worktree, 'add', '.')
  return { main, worktree }
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = null
})

async function command(args: string[], stdin = '', shellCwd = process.cwd()) {
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
        cwd: () => shellCwd,
        exitCode: (value) => {
          code = value
        },
      },
      {
        selectDocWriteTree,
        collectCanonLintInput,
        consumeResumeHandoff: { prepare: async () => async () => ({ lines: [] }) },
        revisionHistory: async () => null,
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

test('a branch-only citation uses the subject worktree containing the shell cwd', async () => {
  const subject = repository()
  upsertProject({
    recordId: newRecordId(),
    name: 'subject',
    path: subject.main,
    canon: true,
    settings: {},
  })
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

  const refused = await command(
    base,
    body.replace('.github/workflows/workflows-sync.yml', '.github/workflows/missing.yml'),
    subject.worktree,
  )
  expect(refused.code).toBe(1)
  expect(refused.out).toBe(`tree: ${realpathSync(subject.worktree)}`)
  expect(refused.err).toContain('canon/reference-path')
  expect(refused.err).toContain(
    `judged against ${realpathSync(subject.worktree)}; pass --cwd <checkout> to validate against another checkout of subject`,
  )

  const accepted = await command(base, body, subject.worktree)
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

test('a refused canon removal names the judged tree and CLI remedy', async () => {
  const subject = repository()
  upsertProject({
    recordId: newRecordId(),
    name: 'subject',
    path: subject.main,
    canon: true,
    settings: {},
  })

  await expect(
    withDocWriteTreeRemedy(
      { project: projectByName('subject')!, root: subject.worktree },
      '--cwd',
      async () => {
        throw new Error(
          canonRemovalRefusal([
            {
              file: 'workflow step verify',
              line: 4,
              rule: 'canon/reference-path',
              message: 'repository path .agents/reference/target.md is not tracked',
            },
          ])!,
        )
      },
    ),
  ).rejects.toThrow(
    `judged against ${subject.worktree}; pass --cwd <checkout> to validate against another checkout of subject`,
  )
})
