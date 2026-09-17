import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkPackBudget } from '../scripts/check-pack-budget.ts'
import { setDoc } from '../test/fixtures/docs.ts'
import { dir } from '../test/fixtures/store.ts'
import { CanonBudgetError, compilePack } from './canon.ts'
import { JOBS } from './jobs.ts'
import { DEFAULT_PACK_BYTES, MAX_INJECT_DOC_BYTES } from './pack-budget.ts'
import { upsertProject } from './projects.ts'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')

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
      'orchestrator/src/pack-budget.ts',
    ])
    expect(readFileSync(join(ROOT, 'orchestrator/src/jobs.ts'), 'utf8')).toContain(
      "from './pack-budget.ts'",
    )
    expect(readFileSync(join(ROOT, 'orchestrator/src/docs.ts'), 'utf8')).toContain(
      "from './pack-budget.ts'",
    )
    expect(readFileSync(join(ROOT, 'orchestrator/scripts/check-pack-budget.ts'), 'utf8')).toContain(
      "from '../src/pack-budget.ts'",
    )
    expect(DEFAULT_PACK_BYTES).toBe(64 * 1024)
    expect(MAX_INJECT_DOC_BYTES).toBe(8 * 1024)
  })

  test('a pack one byte over fails the gate naming the largest item; one byte under passes', async () => {
    upsertProject({ name: 'pack-budget', path: dir, settings: { trunk: 'main' } })
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
      const failures = checkPackBudget()
      expect(failures.some((row) => row.includes('job/understand/largest'))).toBe(true)
    } finally {
      JOBS.understand!.packBytes = measured.bytes
    }
    expect(() => compilePack({ job: 'understand', cwd: dir })).not.toThrow()
    JOBS.understand!.packBytes = old
  })

  test('a small inject write is refused when its affected pack would cross the ceiling', async () => {
    upsertProject({ name: 'proposed-pack-budget', path: dir, settings: { trunk: 'main' } })
    await setDoc({
      scope: 'job',
      subject: 'file-question',
      slug: 'pack-base',
      title: 'Pack base',
      body: 'b'.repeat(2_000),
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
          body: 'x'.repeat(6 * 1024),
        }),
      ).rejects.toThrow(
        /canon pack file-question\/[^ ]+ would be .* bytes over.*largest inject sections to demote/s,
      )
    } finally {
      JOBS['file-question']!.packBytes = old
    }
  })
})
