import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { USER_CANON_MANAGED_MARKER } from './user-canon-home.ts'
import {
  applyUserCanonHomePlan,
  claudeHomeFromEnvironment,
  collectUserCanonHome,
  planUserCanonHome,
} from './user-canon-home-files.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryClaudeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'user-canon-home-'))
  roots.push(home)
  return claudeHomeFromEnvironment({ HOME: home })
}

describe('Claude home canon files', () => {
  test('collects exact bytes from the entry and flat markdown rules', () => {
    const claudeHome = temporaryClaudeHome()
    mkdirSync(join(claudeHome, 'rules'), { recursive: true })
    writeFileSync(join(claudeHome, 'CLAUDE.md'), 'entry\n')
    writeFileSync(join(claudeHome, 'rules/style.md'), 'style')
    writeFileSync(join(claudeHome, 'rules/ignored.txt'), 'ignored')

    expect(collectUserCanonHome(claudeHome).map(({ slug, text }) => ({ slug, text }))).toEqual([
      { slug: 'AGENTS.md', text: 'entry\n' },
      { slug: '.agents/rules/style.md', text: 'style' },
    ])
  })

  test('writes managed content and deletes only a managed stale rule', () => {
    const claudeHome = temporaryClaudeHome()
    mkdirSync(join(claudeHome, 'rules'), { recursive: true })
    writeFileSync(join(claudeHome, 'rules/old.md'), `${USER_CANON_MANAGED_MARKER}old`)
    writeFileSync(join(claudeHome, 'rules/personal.md'), 'personal')
    const plan = planUserCanonHome({
      claudeHome,
      rows: [{ slug: 'AGENTS.md', body: 'entry' }],
      files: collectUserCanonHome(claudeHome),
    })
    applyUserCanonHomePlan(plan)

    expect(readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf8')).toBe(
      `${USER_CANON_MANAGED_MARKER}entry`,
    )
    expect(() => readFileSync(join(claudeHome, 'rules/old.md'), 'utf8')).toThrow()
    expect(readFileSync(join(claudeHome, 'rules/personal.md'), 'utf8')).toBe('personal')
  })
})
