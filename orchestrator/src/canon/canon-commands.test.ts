import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { addAgent, refreshAgents, removeAgent } from '../agent/agent-registry.ts'
import { getDoc, setDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { dispatchCanonCommand } from './canon-commands.ts'

test('worker load measurement resolves a registered agent name to its harness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-load-command-'))
  const home = join(root, 'home')
  const priorHome = process.env.HOME
  try {
    spawnFixtureGitSync(['init'], { cwd: root })
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Architect instructions.')
    writeFileSync(join(root, 'CLAUDE.md'), 'Project instructions.')
    addAgent('grok-variant', { harness: 'grok', backend: 'vendor', model: 'grok-variant' })
    refreshAgents()
    process.env.HOME = home

    const output: string[] = []
    const values = new Map([
      ['cwd', root],
      ['role', 'worker'],
      ['agent', 'grok-variant'],
    ])
    await dispatchCanonCommand(
      ['canon', 'load'],
      {
        has: (name) => values.has(name),
        flag: (name) => values.get(name),
      },
      {
        log: (...parts) => output.push(parts.join(' ')),
        exitCode: () => {},
        cwd: () => root,
      },
    )

    expect(output.join('\n')).toContain(`${root}/CLAUDE.md`)
    expect(output.join('\n')).not.toContain(`${home}/.claude/CLAUDE.md`)
    expect(output[0]).toBe('grok')
  } finally {
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    removeAgent('grok-variant')
    refreshAgents()
    rmSync(root, { recursive: true, force: true })
  }
})

test('canon import can drop a citer and its target after deciding the complete next set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-import-removal-'))
  try {
    const client = createMemoryRecordApiClient()
    const imports: unknown[] = []
    installRecordApiClient({
      ...client,
      importCanon: async (input) => {
        imports.push(input)
        return client.importCanon(input)
      },
    })
    spawnFixtureGitSync(['init'], { cwd: root })
    writeFileSync(join(root, 'AGENTS.md'), 'Current guidance.\n')
    writeFileSync(join(root, 'AGENTS.override.md'), 'Generated output must not become a row.\n')
    spawnFixtureGitSync(['add', 'AGENTS.md', 'AGENTS.override.md'], { cwd: root })
    upsertProject({ name: 'canon-import-removal', path: root, canon: true, settings: {} })
    const target = '.agents/reference/old-target.md'
    await setDoc({
      scope: 'canon',
      subject: 'canon-import-removal',
      slug: target,
      title: target,
      body: '---\ndescription: Old target\n---\n\n# Old target\n',
      reason: 'seed target',
      allowCanonBootstrap: true,
    })
    await setDoc({
      scope: 'canon',
      subject: 'canon-import-removal',
      slug: '.agents/reference/old-citer.md',
      title: 'Old citer',
      body: `---\ndescription: Old citer\n---\n\nRead [the target](${target}).\n`,
      reason: 'seed citer',
      allowCanonBootstrap: true,
    })
    const output: string[] = []
    const values = new Map([
      ['project', 'canon-import-removal'],
      ['cwd', root],
      ['reason', 'import complete next set'],
    ])

    await dispatchCanonCommand(
      ['canon', 'import'],
      { has: (name) => values.has(name), flag: (name) => values.get(name) },
      { log: (...parts) => output.push(parts.join(' ')), exitCode: () => {}, cwd: () => root },
    )

    expect(getDoc('canon', 'canon-import-removal', target)).toBeNull()
    expect(getDoc('canon', 'canon-import-removal', '.agents/reference/old-citer.md')).toBeNull()
    expect(imports).toHaveLength(0)
    expect(getDoc('canon', 'canon-import-removal', 'AGENTS.override.md')).toBeNull()
    expect(output).toContain('delete .agents/reference/old-target.md')
    expect(output).toContain('delete .agents/reference/old-citer.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('project canon import bootstraps findings and refuses findings on the next import', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-import-bootstrap-'))
  try {
    installRecordApiClient(createMemoryRecordApiClient())
    spawnFixtureGitSync(['init'], { cwd: root })
    writeFileSync(join(root, 'AGENTS.md'), 'Keep 123 rules.\n')
    spawnFixtureGitSync(['add', 'AGENTS.md'], { cwd: root })
    upsertProject({ name: 'canon-import-bootstrap', path: root, canon: true, settings: {} })
    const values = new Map([
      ['project', 'canon-import-bootstrap'],
      ['cwd', root],
      ['reason', 'test bootstrap'],
    ])
    const presentation = { log: () => {}, exitCode: () => {}, cwd: () => root }

    await dispatchCanonCommand(
      ['canon', 'import'],
      { has: (name) => values.has(name), flag: (name) => values.get(name) },
      presentation,
    )
    expect(getDoc('canon', 'canon-import-bootstrap', 'AGENTS.md')?.body).toContain('123')

    writeFileSync(join(root, 'AGENTS.md'), 'Keep 123 rules.\nIt used to differ.\n')
    await expect(
      dispatchCanonCommand(
        ['canon', 'import'],
        { has: (name) => values.has(name), flag: (name) => values.get(name) },
        presentation,
      ),
    ).rejects.toThrow('refusing canon write')
    expect(getDoc('canon', 'canon-import-bootstrap', 'AGENTS.md')?.body).not.toContain('used to')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('project canon import dry-run prints the plan and writes neither store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-import-dry-run-'))
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
    writeFileSync(join(root, 'AGENTS.md'), 'Keep 123 rules.\n')
    spawnFixtureGitSync(['add', 'AGENTS.md'], { cwd: root })
    upsertProject({ name: 'canon-import-dry-run', path: root, canon: true, settings: {} })
    const output: string[] = []
    const values = new Map<string, string | true>([
      ['project', 'canon-import-dry-run'],
      ['cwd', root],
      ['reason', 'test dry run'],
      ['dry-run', true],
    ])

    await dispatchCanonCommand(
      ['canon', 'import'],
      {
        has: (name) => values.has(name),
        flag: (name) =>
          typeof values.get(name) === 'string' ? String(values.get(name)) : undefined,
      },
      { log: (...parts) => output.push(parts.join(' ')), exitCode: () => {}, cwd: () => root },
    )

    expect(hostedWrites).toBe(0)
    expect(getDoc('canon', 'canon-import-dry-run', 'AGENTS.md')).toBeNull()
    expect(output).toContain('write AGENTS.md')
    expect(output).toContain('bootstrap: yes')
    expect(output).toContain('would import 1 canon rows, remove 0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('project canon hydrate dry-run prints the plan and leaves the tree unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-hydrate-dry-run-'))
  try {
    spawnFixtureGitSync(['init'], { cwd: root })
    writeFileSync(join(root, 'AGENTS.md'), 'Keep the tree.\n')
    spawnFixtureGitSync(['add', 'AGENTS.md'], { cwd: root })
    upsertProject({ name: 'canon-hydrate-dry-run', path: root, canon: true, settings: {} })
    const output: string[] = []
    const values = new Map<string, string | true>([
      ['project', 'canon-hydrate-dry-run'],
      ['cwd', root],
      ['dry-run', true],
    ])

    await dispatchCanonCommand(
      ['canon', 'hydrate'],
      {
        has: (name) => values.has(name),
        flag: (name) =>
          typeof values.get(name) === 'string' ? String(values.get(name)) : undefined,
      },
      { log: (...parts) => output.push(parts.join(' ')), exitCode: () => {}, cwd: () => root },
    )

    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
    expect(output).toContain('delete AGENTS.md')
    expect(output).toContain('would hydrate 1 paths')
    expect(output.some((line) => line.startsWith('hydrated '))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('project canon hydrate refuses an empty store that would delete managed tree files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-hydrate-empty-store-'))
  const main = mkdtempSync(join(tmpdir(), 'canon-hydrate-empty-main-'))
  try {
    spawnFixtureGitSync(['init'], { cwd: main })
    spawnFixtureGitSync(['init'], { cwd: root })
    writeFileSync(join(root, 'AGENTS.md'), 'Keep the tree.\n')
    spawnFixtureGitSync(['add', 'AGENTS.md'], { cwd: root })
    upsertProject({ name: 'canon-hydrate-empty-store', path: main, canon: true, settings: {} })
    const output: string[] = []

    await expect(
      dispatchCanonCommand(
        ['canon', 'hydrate'],
        {
          has: (name) => name === 'project' || name === 'cwd',
          flag: (name) =>
            name === 'project' ? 'canon-hydrate-empty-store' : name === 'cwd' ? root : undefined,
        },
        { log: (...parts) => output.push(parts.join(' ')), exitCode: () => {}, cwd: () => root },
      ),
    ).rejects.toThrow('refusing canon hydrate: this store holds no project canon')
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
    expect(output).toContain('delete AGENTS.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(main, { recursive: true, force: true })
  }
})
