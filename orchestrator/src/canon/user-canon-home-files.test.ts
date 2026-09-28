import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { USER_CANON_MANAGED_MARKER } from './user-canon-home.ts'
import {
  applyUserCanonHomePlans,
  collectUserCanonHome,
  planUserCanonHome,
  userCanonHomesFromEnvironment as resolveUserCanonHomesFromEnvironment,
  type UserCanonHomeTarget,
  userCanonHomeInstallationStatus,
  userCanonHomeOverridesStatus,
  userCanonHomePlanDrift,
} from './user-canon-home-files.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function userCanonHomesFromEnvironment(env: NodeJS.ProcessEnv): UserCanonHomeTarget[] {
  return resolveUserCanonHomesFromEnvironment(
    env,
    env.ORCH_RUNS ?? join(env.HOME!, 'orchestrator-runs'),
  )
}

function temporaryClaudeHome(): UserCanonHomeTarget {
  const home = mkdtempSync(join(tmpdir(), 'user-canon-home-'))
  roots.push(home)
  const target = userCanonHomesFromEnvironment({ HOME: home })[0]!
  mkdirSync(target.path)
  return { ...target, installed: true }
}

describe('Claude home canon files', () => {
  test('collects exact bytes from the entry and flat markdown rules', () => {
    const claudeHome = temporaryClaudeHome()
    mkdirSync(join(claudeHome.path, 'rules'), { recursive: true })
    writeFileSync(join(claudeHome.path, 'CLAUDE.md'), 'entry\n')
    writeFileSync(join(claudeHome.path, 'rules/style.md'), 'style')
    writeFileSync(join(claudeHome.path, 'rules/ignored.txt'), 'ignored')

    expect(collectUserCanonHome(claudeHome).map(({ slug, text }) => ({ slug, text }))).toEqual([
      { slug: 'AGENTS.md', text: 'entry\n' },
      { slug: '.agents/rules/style.md', text: 'style' },
    ])
  })

  test('writes managed content and deletes only a managed stale rule', () => {
    const claudeHome = temporaryClaudeHome()
    mkdirSync(join(claudeHome.path, 'rules'), { recursive: true })
    writeFileSync(join(claudeHome.path, 'rules/old.md'), `${USER_CANON_MANAGED_MARKER}old`)
    writeFileSync(join(claudeHome.path, 'rules/personal.md'), 'personal')
    const plan = planUserCanonHome({
      home: claudeHome,
      rows: [{ slug: 'AGENTS.md', body: 'entry' }],
      files: collectUserCanonHome(claudeHome),
    })
    applyUserCanonHomePlans([plan], {
      BOTTEGA_STATE_HOME: join(dirname(claudeHome.path), 'state'),
    })

    expect(readFileSync(join(claudeHome.path, 'CLAUDE.md'), 'utf8')).toBe(
      `${USER_CANON_MANAGED_MARKER}entry`,
    )
    expect(() => readFileSync(join(claudeHome.path, 'rules/old.md'), 'utf8')).toThrow()
    expect(readFileSync(join(claudeHome.path, 'rules/personal.md'), 'utf8')).toBe('personal')
  })

  test('refusal names the file-wins and store-wins remedies', () => {
    const claudeHome = temporaryClaudeHome()
    writeFileSync(join(claudeHome.path, 'CLAUDE.md'), 'local')

    expect(() =>
      planUserCanonHome({
        home: claudeHome,
        rows: [{ slug: 'AGENTS.md', body: 'stored' }],
        files: collectUserCanonHome(claudeHome),
      }),
    ).toThrow(/orch canon import --user.*orch canon hydrate --user --adopt/s)
  })

  test('adopts an unmarked file only after backing it up privately', () => {
    const claudeHome = temporaryClaudeHome()
    const path = join(claudeHome.path, 'CLAUDE.md')
    writeFileSync(path, 'local')
    const state = join(dirname(claudeHome.path), 'state')
    const plan = planUserCanonHome({
      home: claudeHome,
      rows: [{ slug: 'AGENTS.md', body: 'stored' }],
      files: collectUserCanonHome(claudeHome),
      adopt: true,
    })

    const backups = applyUserCanonHomePlans([plan], { BOTTEGA_STATE_HOME: state })

    expect(plan.adopts.map(({ path: adoptedPath }) => adoptedPath)).toEqual([path])
    expect(backups).toHaveLength(1)
    expect(readFileSync(backups[0]!, 'utf8')).toBe('local')
    expect(lstatSync(backups[0]!).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toBe(`${USER_CANON_MANAGED_MARKER}stored`)
  })

  test('an adopt dry-run plan does not write or back up the file', () => {
    const claudeHome = temporaryClaudeHome()
    const path = join(claudeHome.path, 'CLAUDE.md')
    writeFileSync(path, 'local')

    const plan = planUserCanonHome({
      home: claudeHome,
      rows: [{ slug: 'AGENTS.md', body: 'stored' }],
      files: collectUserCanonHome(claudeHome),
      adopt: true,
    })

    const state = join(dirname(claudeHome.path), 'state')
    expect(applyUserCanonHomePlans([plan], { BOTTEGA_STATE_HOME: state }, true)).toEqual([])
    expect(plan.adopts.map(({ path: adoptedPath }) => adoptedPath)).toEqual([path])
    expect(readFileSync(path, 'utf8')).toBe('local')
    expect(() => lstatSync(state)).toThrow()
  })

  test('refuses hard-linked entry and rules files before creating a backup', () => {
    for (const [relativePath, slug] of [
      ['CLAUDE.md', 'AGENTS.md'],
      ['rules/personal.md', '.agents/rules/personal.md'],
    ] as const) {
      const claudeHome = temporaryClaudeHome()
      const path = join(claudeHome.path, relativePath)
      const outside = join(dirname(claudeHome.path), `${slug.replaceAll('/', '-')}-outside`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(outside, 'local')
      linkSync(outside, path)
      const state = join(dirname(claudeHome.path), 'state')

      expect(() =>
        planUserCanonHome({
          home: claudeHome,
          rows: [{ slug, body: 'stored' }],
          files: collectUserCanonHome(claudeHome),
          adopt: true,
        }),
      ).toThrow(/hard links are not allowed/)
      expect(existsSync(state)).toBe(false)
      expect(readFileSync(path, 'utf8')).toBe('local')
      expect(readFileSync(outside, 'utf8')).toBe('local')
    }
  })

  test('backs up every adopt before writing and restores earlier writes after failure', () => {
    const claudeHome = temporaryClaudeHome()
    const rules = join(claudeHome.path, 'rules')
    const entry = join(claudeHome.path, 'CLAUDE.md')
    const rule = join(rules, 'personal.md')
    mkdirSync(rules, { recursive: true })
    writeFileSync(entry, 'local entry')
    writeFileSync(rule, 'local rule')
    const state = join(dirname(claudeHome.path), 'state')
    const plan = planUserCanonHome({
      home: claudeHome,
      rows: [
        { slug: 'AGENTS.md', body: 'stored entry' },
        { slug: '.agents/rules/personal.md', body: 'stored rule' },
      ],
      files: collectUserCanonHome(claudeHome),
      adopt: true,
    })

    chmodSync(rules, 0o500)
    let failure: unknown
    try {
      applyUserCanonHomePlans([plan], { BOTTEGA_STATE_HOME: state })
    } catch (error) {
      failure = error
    } finally {
      chmodSync(rules, 0o700)
    }

    expect(String(failure)).toContain(entry)
    expect(String(failure)).toContain(rule)
    const backupDirectory = join(state, 'orchestrator', 'settings-backups')
    const backups = readdirSync(backupDirectory)
      .filter((name) => name.endsWith('.bak'))
      .map((name) => join(backupDirectory, name))
    expect(backups).toHaveLength(2)
    for (const backup of backups) expect(String(failure)).toContain(backup)
    expect(readFileSync(entry, 'utf8')).toBe('local entry')
    expect(readFileSync(rule, 'utf8')).toBe('local rule')
  })

  test('refuses a file symlink without reading or writing through it', () => {
    const claudeHome = temporaryClaudeHome()
    const outside = join(dirname(claudeHome.path), 'outside.md')
    writeFileSync(outside, 'outside secret')
    symlinkSync(outside, join(claudeHome.path, 'CLAUDE.md'))

    expect(() => collectUserCanonHome(claudeHome)).toThrow(
      /CLAUDE\.md: symbolic link targets.*replace the link/,
    )
    const plan = planUserCanonHome({
      home: claudeHome,
      rows: [{ slug: 'AGENTS.md', body: 'replacement' }],
      files: [],
    })
    expect(() => applyUserCanonHomePlans([plan])).toThrow(/CLAUDE\.md: symbolic link targets/)
    expect(readFileSync(outside, 'utf8')).toBe('outside secret')
  })

  test('refuses a symlinked rules directory and leaves its outside target untouched', () => {
    const claudeHome = temporaryClaudeHome()
    const outside = join(dirname(claudeHome.path), 'outside-rules')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.md'), 'outside secret')
    symlinkSync(outside, join(claudeHome.path, 'rules'))

    expect(() => collectUserCanonHome(claudeHome)).toThrow(
      /rules: symbolic link targets.*replace the link/,
    )
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('outside secret')
  })

  test('refuses the whole batch when a target changes after collection', () => {
    const claudeHome = temporaryClaudeHome()
    const entry = join(claudeHome.path, 'CLAUDE.md')
    writeFileSync(entry, `${USER_CANON_MANAGED_MARKER}collected`)
    const plan = planUserCanonHome({
      home: claudeHome,
      rows: [{ slug: 'AGENTS.md', body: 'rendered' }],
      files: collectUserCanonHome(claudeHome),
    })
    writeFileSync(entry, `${USER_CANON_MANAGED_MARKER}later`)
    const state = join(dirname(claudeHome.path), 'state')

    expect(() => applyUserCanonHomePlans([plan], { BOTTEGA_STATE_HOME: state })).toThrow(
      /changed after collection/,
    )
    expect(readFileSync(entry, 'utf8')).toBe(`${USER_CANON_MANAGED_MARKER}later`)
    expect(existsSync(state)).toBe(false)
  })

  test('keeps a deletion target changed immediately before removal', () => {
    const claudeHome = temporaryClaudeHome()
    const rules = join(claudeHome.path, 'rules')
    const stale = join(rules, 'stale.md')
    mkdirSync(rules)
    writeFileSync(stale, `${USER_CANON_MANAGED_MARKER}collected`)
    const plan = planUserCanonHome({
      home: claudeHome,
      rows: [],
      files: collectUserCanonHome(claudeHome),
    })

    expect(() =>
      applyUserCanonHomePlans(
        [plan],
        { BOTTEGA_STATE_HOME: join(dirname(claudeHome.path), 'state') },
        false,
        { beforeDelete: () => writeFileSync(stale, `${USER_CANON_MANAGED_MARKER}later`) },
      ),
    ).toThrow(/changed after collection/)
    expect(readFileSync(stale, 'utf8')).toBe(`${USER_CANON_MANAGED_MARKER}later`)
  })

  test('rollback keeps an edit made after this batch installed a write', () => {
    const claudeHome = temporaryClaudeHome()
    const entry = join(claudeHome.path, 'CLAUDE.md')
    writeFileSync(entry, `${USER_CANON_MANAGED_MARKER}collected`)
    const plan = planUserCanonHome({
      home: claudeHome,
      rows: [{ slug: 'AGENTS.md', body: 'rendered' }],
      files: collectUserCanonHome(claudeHome),
    })
    let failure: unknown

    try {
      applyUserCanonHomePlans(
        [plan],
        { BOTTEGA_STATE_HOME: join(dirname(claudeHome.path), 'state') },
        false,
        {
          afterMutation: (path) => {
            if (path !== entry) return
            writeFileSync(entry, 'concurrent edit')
            throw new Error('forced failure')
          },
        },
      )
    } catch (error) {
      failure = error
    }

    expect(readFileSync(entry, 'utf8')).toBe('concurrent edit')
    expect(String(failure)).toContain(`${entry}: restoration conflict`)
  })

  test('refuses a dangling entry symlink with the link intact', () => {
    const claudeHome = temporaryClaudeHome()
    const entry = join(claudeHome.path, 'CLAUDE.md')
    const missing = join(dirname(claudeHome.path), 'missing.md')
    symlinkSync(missing, entry)
    const plan = planUserCanonHome({
      home: claudeHome,
      rows: [{ slug: 'AGENTS.md', body: 'rendered' }],
      files: [],
    })

    expect(() => applyUserCanonHomePlans([plan])).toThrow(/symbolic link targets/)
    expect(lstatSync(entry).isSymbolicLink()).toBe(true)
    expect(() => readFileSync(entry, 'utf8')).toThrow()
  })
})

describe('Codex and Grok home canon files', () => {
  test('writes each installed harness entry with the Markdown marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'user-canon-harnesses-'))
    roots.push(root)
    const homes = userCanonHomesFromEnvironment({ HOME: root }).slice(1)
    for (const home of homes) {
      mkdirSync(home.path)
      const installed = { ...home, installed: true }
      const plan = planUserCanonHome({
        home: installed,
        rows: [{ slug: 'AGENTS.md', body: 'operator canon' }],
        files: collectUserCanonHome(installed),
      })
      applyUserCanonHomePlans([plan])
      expect(readFileSync(join(home.path, 'AGENTS.md'), 'utf8')).toBe(
        `${USER_CANON_MANAGED_MARKER}operator canon`,
      )
    }
  })

  test('refuses differing unmarked entries with both remedies', () => {
    const root = mkdtempSync(join(tmpdir(), 'user-canon-refusal-'))
    roots.push(root)
    for (const home of userCanonHomesFromEnvironment({ HOME: root }).slice(1)) {
      mkdirSync(home.path)
      const installed = { ...home, installed: true }
      writeFileSync(join(home.path, 'AGENTS.md'), 'local')
      expect(() =>
        planUserCanonHome({
          home: installed,
          rows: [{ slug: 'AGENTS.md', body: 'stored' }],
          files: collectUserCanonHome(installed),
        }),
      ).toThrow(/orch canon import --user.*orch canon hydrate --user --adopt/s)
    }
  })

  test('reports missing harness homes as not installed and does not plan writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'user-canon-missing-'))
    roots.push(root)
    for (const home of userCanonHomesFromEnvironment({ HOME: root }).slice(1)) {
      expect(home.installed).toBe(false)
      expect(userCanonHomeInstallationStatus(home)).toContain('not installed')
      expect(existsSync(home.path)).toBe(false)
    }
  })

  test('new harness entry drift is visible to check planning', () => {
    const root = mkdtempSync(join(tmpdir(), 'user-canon-check-'))
    roots.push(root)
    for (const home of userCanonHomesFromEnvironment({ HOME: root }).slice(1)) {
      mkdirSync(home.path)
      const installed = { ...home, installed: true }
      const plan = planUserCanonHome({
        home: installed,
        rows: [{ slug: 'AGENTS.md', body: 'stored' }],
        files: [],
      })
      expect(userCanonHomePlanDrift(plan)).toBe(1)
    }
  })

  test('honors CODEX_HOME and GROK_HOME overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'user-canon-overrides-'))
    roots.push(root)
    const codex = join(root, 'custom-codex')
    const grok = join(root, 'custom-grok')
    mkdirSync(codex)
    mkdirSync(grok)
    const homes = userCanonHomesFromEnvironment({ HOME: root, CODEX_HOME: codex, GROK_HOME: grok })

    expect(homes[1]).toMatchObject({ path: codex, installed: true })
    expect(homes[2]).toMatchObject({ path: grok, installed: true })
  })

  test('ignores run-state overrides with one status line and uses operator defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'user-canon-run-overrides-'))
    roots.push(root)
    const runs = join(root, 'orchestrator-runs')
    const homes = userCanonHomesFromEnvironment({
      HOME: root,
      ORCH_RUNS: runs,
      CODEX_HOME: join(runs, '41', 'codex'),
      GROK_HOME: join(runs, '41', 'grok'),
    })

    expect(homes[1]).toMatchObject({
      path: join(root, '.codex'),
      ignoredRunOverride: true,
    })
    expect(homes[2]).toMatchObject({ path: join(root, '.grok'), ignoredRunOverride: true })
    expect(userCanonHomeOverridesStatus(homes)).toBe(
      'ignored harness home overrides inside the orchestrator run-state directory: CODEX_HOME, GROK_HOME; using operator defaults',
    )
  })

  test('a Grok failure rolls back every home mutation and removes created paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'user-canon-batch-'))
    roots.push(root)
    const homes = userCanonHomesFromEnvironment({ HOME: root }).map((home) => ({
      ...home,
      installed: true,
    }))
    for (const home of homes) mkdirSync(home.path)
    const claudeEntry = join(homes[0]!.path, 'CLAUDE.md')
    const claudeRules = join(homes[0]!.path, 'rules')
    const staleRule = join(claudeRules, 'stale.md')
    const codexEntry = join(homes[1]!.path, 'AGENTS.md')
    const grokEntry = join(homes[2]!.path, 'AGENTS.md')
    mkdirSync(claudeRules)
    writeFileSync(claudeEntry, `${USER_CANON_MANAGED_MARKER}old entry`)
    writeFileSync(staleRule, `${USER_CANON_MANAGED_MARKER}old rule`)
    const plans = homes.map((home) =>
      planUserCanonHome({
        home,
        rows: [{ slug: 'AGENTS.md', body: 'new entry' }],
        files: collectUserCanonHome(home),
      }),
    )
    const state = join(root, 'state')

    chmodSync(homes[2]!.path, 0o500)
    let failure: unknown
    try {
      applyUserCanonHomePlans(plans, { BOTTEGA_STATE_HOME: state })
    } catch (error) {
      failure = error
    } finally {
      chmodSync(homes[2]!.path, 0o700)
    }

    expect(String(failure)).toContain('user canon batch hydrate failed')
    expect(String(failure)).toContain(claudeEntry)
    expect(String(failure)).toContain(staleRule)
    expect(readFileSync(claudeEntry, 'utf8')).toBe(`${USER_CANON_MANAGED_MARKER}old entry`)
    expect(readFileSync(staleRule, 'utf8')).toBe(`${USER_CANON_MANAGED_MARKER}old rule`)
    expect(existsSync(codexEntry)).toBe(false)
    expect(existsSync(grokEntry)).toBe(false)
    const backups = readdirSync(join(state, 'orchestrator', 'settings-backups')).filter((name) =>
      name.endsWith('.bak'),
    )
    expect(backups).toHaveLength(2)
    for (const backup of backups) expect(String(failure)).toContain(backup)
  })
})
