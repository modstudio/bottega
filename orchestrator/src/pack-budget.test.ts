import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CanonBudgetError, JOBS, compilePack, dir, setDoc, upsertProject } from '../test/fixture.ts'
import { DEFAULT_PACK_BYTES, MAX_INJECT_DOC_BYTES } from './pack-budget.ts'
import { checkPackBudget } from '../scripts/check-pack-budget.ts'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
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
      /export const DEFAULT_PACK_BYTES\s*=/.test(readFileSync(path, 'utf8')))
    expect(assignments.map((path) => path.slice(ROOT.length + 1))).toEqual([
      'orchestrator/src/pack-budget.ts',
    ])
    expect(readFileSync(join(ROOT, 'orchestrator/src/jobs.ts'), 'utf8'))
      .toContain("from './pack-budget.ts'")
    expect(readFileSync(join(ROOT, 'orchestrator/src/docs.ts'), 'utf8'))
      .toContain("from './pack-budget.ts'")
    expect(readFileSync(join(ROOT, 'orchestrator/scripts/check-pack-budget.ts'), 'utf8'))
      .toContain("from '../src/pack-budget.ts'")
    expect(DEFAULT_PACK_BYTES).toBe(64 * 1024)
    expect(MAX_INJECT_DOC_BYTES).toBe(8 * 1024)
  })

  test('a pack one byte over fails the gate naming the largest item; one byte under passes', () => {
    upsertProject({ name: 'pack-budget', path: dir, settings: { trunk: 'main' } })
    setDoc({
      scope: 'global', subject: null, slug: 'largest', title: 'Largest',
      body: 'L'.repeat(40),
    })
    setDoc({
      scope: 'global', subject: null, slug: 'smallest', title: 'Smallest',
      body: 's',
    })
    const old = JOBS.understand!.packBytes
    const measured = compilePack({ job: 'understand', cwd: dir })
    JOBS.understand!.packBytes = measured.bytes - 1
    try {
      expect(() => compilePack({ job: 'understand', cwd: dir })).toThrow(CanonBudgetError)
      let message = ''
      try { compilePack({ job: 'understand', cwd: dir }) }
      catch (error) { message = (error as Error).message }
      expect(message).toContain('global/_/largest')
      expect(message.indexOf('global/_/largest')).toBeLessThan(message.indexOf('global/_/smallest'))
      const failures = checkPackBudget()
      expect(failures.some((row) => row.includes('global/_/largest'))).toBe(true)
    } finally {
      JOBS.understand!.packBytes = measured.bytes
    }
    expect(() => compilePack({ job: 'understand', cwd: dir })).not.toThrow()
    JOBS.understand!.packBytes = old
  })
})
