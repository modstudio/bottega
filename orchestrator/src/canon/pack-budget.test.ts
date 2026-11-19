import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newRecordId } from '../../../shared/record-id.ts'
import { checkTreePackBudget } from '../../scripts/check-pack-budget.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import { dir } from '../../test/fixtures/store.ts'
import { JOBS } from '../jobs/jobs.ts'
import { upsertProject } from '../project/projects.ts'
import { CanonBudgetError, compilePack } from './canon.ts'
import { collectCanonLintInput } from './canon-files.ts'
import { DEFAULT_PACK_BYTES, MAX_INJECT_DOC_BYTES } from './pack-budget.ts'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')

/**
 * Walk THIS tree's sources, not every copy of them on disk.
 *
 * `.claude/worktrees` and `orchestrator/runs` both hold whole copies of the
 * source tree - a retained worker worktree, and a run's archived artifacts.
 * Descending into them made this invariant measure repository HISTORY: 152
 * assignments were reported where one was expected, because worktrees cut
 * before DEFAULT_PACK_BYTES moved out of jobs.ts still carry the old
 * assignment. It also pushed the walk past its 5s budget at 6547ms.
 *
 * Excluding them by name is deliberate rather than clever: the alternative,
 * a gitignore-aware walk, would silently change what this invariant covers
 * whenever the ignore file changes.
 */
const UNWALKED = new Set(['node_modules', 'dist', '.claude', 'runs'])

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (UNWALKED.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTs(path))
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

describe('canon pack budget', () => {
  test('DEFAULT_PACK_BYTES is assigned in one module and imported by the gate, dispatch and set_doc', () => {
    const files = walkTs(ROOT)
    const assignments = files.filter((path) =>
      /export const DEFAULT_PACK_BYTES\s*=/.test(readFileSync(path, 'utf8')),
    )
    expect(assignments.map((path) => path.slice(ROOT.length + 1))).toEqual([
      'orchestrator/src/canon/pack-budget.ts',
    ])
    expect(readFileSync(join(ROOT, 'orchestrator/src/jobs/jobs.ts'), 'utf8')).toContain(
      "from '../canon/pack-budget.ts'",
    )
    expect(readFileSync(join(ROOT, 'orchestrator/src/doc/docs.ts'), 'utf8')).toContain(
      "from '../canon/pack-budget.ts'",
    )
    expect(readFileSync(join(ROOT, 'orchestrator/scripts/check-pack-budget.ts'), 'utf8')).toContain(
      "from '../src/canon/pack-budget.ts'",
    )
    expect(DEFAULT_PACK_BYTES).toBe(64 * 1024)
    expect(MAX_INJECT_DOC_BYTES).toBe(8 * 1024)
  })

  test('a pack one byte over fails the gate naming the largest item; one byte under passes', async () => {
    upsertProject({
      recordId: newRecordId(),
      name: 'pack-budget',
      path: dir,
      settings: { trunk: 'main' },
    })
    await setDoc({
      scope: 'job',
      subject: 'understand',
      slug: 'largest',
      title: 'Largest',
      body: 'L'.repeat(40),
    })
    await setDoc({
      scope: 'job',
      subject: 'understand',
      slug: 'smallest',
      title: 'Smallest',
      body: 's',
    })
    const old = JOBS.understand!.packBytes
    const measured = compilePack({ job: 'understand', cwd: dir })
    JOBS.understand!.packBytes = measured.bytes - 1
    try {
      expect(() => compilePack({ job: 'understand', cwd: dir })).toThrow(CanonBudgetError)
      let message = ''
      try {
        compilePack({ job: 'understand', cwd: dir })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('job/understand/largest')
      expect(message.indexOf('job/understand/largest')).toBeLessThan(
        message.indexOf('job/understand/smallest'),
      )
    } finally {
      JOBS.understand!.packBytes = measured.bytes
    }
    expect(() => compilePack({ job: 'understand', cwd: dir })).not.toThrow()
    JOBS.understand!.packBytes = old
  })

  test('the tree-only gate measures real canon and rejects an inflated canon input', () => {
    const files = collectCanonLintInput(ROOT).files
    expect(checkTreePackBudget(files)).toEqual([])
    const inflated = files.map((file) =>
      file.path === 'AGENTS.md' ? { ...file, text: 'x'.repeat(DEFAULT_PACK_BYTES + 1) } : file,
    )
    const failures = checkTreePackBudget(inflated)
    expect(failures.length).toBe(Object.keys(JOBS).length)
    expect(failures[0]).toEqual(
      expect.objectContaining({ bytes: expect.any(Number), ceiling: expect.any(Number) }),
    )
  })

  test('a small inject write is refused when its affected pack would cross the ceiling', async () => {
    upsertProject({
      recordId: newRecordId(),
      name: 'proposed-pack-budget',
      path: dir,
      settings: { trunk: 'main' },
    })
    await setDoc({
      scope: 'job',
      subject: 'file-question',
      slug: 'pack-base',
      title: 'Pack base',
      body: 'Valid content. '.repeat(150),
    })
    const old = JOBS['file-question']!.packBytes
    JOBS['file-question']!.packBytes = compilePack({ job: 'file-question', cwd: dir }).bytes + 5_000
    try {
      await expect(
        setDoc({
          scope: 'job',
          subject: 'file-question',
          slug: 'six-kib',
          title: 'Six KiB',
          body: 'More valid content. '.repeat(350),
        }),
      ).rejects.toThrow(
        /canon pack file-question\/[^ ]+ would be \d+ bytes; ceiling is \d+ bytes.*largest inject sections to demote/s,
      )
    } finally {
      JOBS['file-question']!.packBytes = old
    }
  })

  test('a canon row write is refused when its affected project pack would cross the ceiling', async () => {
    const project = 'proposed-canon-budget'
    upsertProject({
      recordId: newRecordId(),
      name: project,
      path: dir,
      settings: { trunk: 'main' },
    })
    const old = JOBS['file-question']!.packBytes
    JOBS['file-question']!.packBytes = compilePack({ job: 'file-question', cwd: dir }).bytes + 20
    try {
      await expect(
        setDoc({
          scope: 'canon',
          subject: project,
          slug: 'AGENTS.md',
          title: 'Project canon',
          body: 'Keep project decisions explicit and current for every implementation worker.',
          allowCanonBootstrap: true,
        }),
      ).rejects.toThrow(
        /canon pack file-question\/proposed-canon-budget would be \d+ bytes; ceiling is \d+ bytes.*largest packed tiers.*never raise the pack budget/s,
      )
    } finally {
      JOBS['file-question']!.packBytes = old
    }
  })
})
