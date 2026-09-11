import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db, declaredCreate, upsertProject } from '../test/fixture.ts'
import { dispatchCommand } from './dispatch-commands.ts'

beforeEach(() => { process.env.ORCH_DEPTH = '0'; process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session' })

const flagsFor = (argv: string[]) => ({
  has: (name: string) => argv.includes(`--${name}`),
  flag: (name: string) => {
    const at = argv.indexOf(`--${name}`)
    return at >= 0 ? argv[at + 1] : undefined
  },
  values: (name: string) => argv.flatMap((value, index) => value === `--${name}` ? [argv[index + 1]!] : []),
})

function presentation(errors: string[]) {
  return {
    usage: () => { throw new Error('usage') }, doUsage: () => { throw new Error('do usage') },
    error: (...values: unknown[]) => errors.push(values.join(' ')), printRunId: () => {},
    readPrompt: async () => { throw new Error('/definitely/not/a/prompt') },
    validateSchema: () => ({}), warnCallerDrift: () => {}, contractConflicts: () => [],
    warnImplementContractConflicts: () => {}, checkoutHasUncommittedWork: () => false,
    resolveBase: () => ({}), implicitReviewWarning: () => '',
    resolveDispatchOptions: async () => ({ agent: undefined, transport: 'cli' as const, transportExplicit: false, avoid: [], distinctModels: [], mcp: undefined }),
    detach: async () => 1, follow: async () => ({}),
  }
}

async function command(argv: string[], overrides: Record<string, unknown> = {}) {
  const errors: string[] = []; const ids: number[] = []; const conflicts: { line: number; text: string }[][] = []
  const shown = {
    ...presentation(errors),
    readPrompt: async () => 'Make the requested change.',
    printRunId: (id: number) => ids.push(id),
    warnImplementContractConflicts: (value: { line: number; text: string }[]) => conflicts.push(value),
    ...overrides,
  }
  try { await dispatchCommand(argv, flagsFor(argv), shown as any); return { code: 0, errors, ids, conflicts } }
  catch (error) { return { code: 1, error: String(error), errors, ids, conflicts } }
}

test('an unattributed run warns with the explicit repo remedy', async () => {
  const argv = ['do', 'summarize', '--file', '/definitely/not/a/prompt']; const errors: string[] = []
  await expect(dispatchCommand(argv, flagsFor(argv), presentation(errors))).rejects.toThrow('/definitely/not/a/prompt')
  expect(errors.join('\n')).toContain('will not be attributed to any project')
  expect(errors.join('\n')).toContain('--repo <name>')
})

test('an explicit repo is validated before the prompt is read', async () => {
  const argv = ['do', 'summarize', '--repo', 'not-registered', '--file', '/definitely/not/a/prompt']
  let read = false; const shown = presentation([])
  shown.readPrompt = async () => { read = true; throw new Error('prompt read') }
  await expect(dispatchCommand(argv, flagsFor(argv), shown)).rejects.toThrow('unknown repo "not-registered"')
  expect(read).toBe(false)
})

test('dispatch preflight enforces a clean registered main checkout', async () => {
  upsertProject({ name: 'dirty-main', path: process.cwd(), settings: { requireCleanMain: true } })
  const result = await command(['do', 'implement', 'change it'])
  expect(result.error).toContain('has tracked modifications')
  expect(result.ids).toEqual([])
})

test('a missing required dispatch flag exits non-zero without claiming a run', async () => {
  upsertProject({ name: 'needs-key', path: process.cwd(), settings: { requireCleanMain: false, worktree: { branch: 'feature/{key}-{id}' } } })
  const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
  const result = await command(['do', 'implement', 'change it'])
  expect(result.error).toContain('--key <KEY-123>')
  expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
})

test('a writing run missing its branch key exits before git and does not claim a run', async () => {
  upsertProject({ name: 'branch-key', path: process.cwd(), settings: { requireCleanMain: false, worktree: { branch: '{key}-orch-{id}' } } })
  const result = await command(['do', 'fix', 'change it'])
  expect(result.error).toContain('--key')
  expect(result.ids).toEqual([])
})

test('every repository-reading job refuses a non-git cwd without dispatch artifacts', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'orch-non-git-')))
  try {
    upsertProject({ name: 'non-git', path: cwd, settings: { requireCleanMain: false } })
    for (const job of ['implement', 'fix', 'review-lens', 'understand']) {
      const result = await command(['do', job, '--cwd', cwd, 'inspect', ...(job === 'review-lens' ? ['--lens', 'correctness'] : [])])
      expect(result.error).toContain('git checkout')
      expect(result.ids).toEqual([])
    }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('orch do accepts every documented starship seed spelling before execution', async () => {
  upsertProject({ name: 'seeded', path: process.cwd(), settings: { requireCleanMain: false, worktree: {
    create: declaredCreate('true', ['{seed}']), branch: 'task/{id}', seeds: ['empty', 'small', 'full'],
  } } })
  for (const seed of ['empty', 'small', 'full']) {
    const result = await command(['do', 'implement', 'change it', '--seed', seed])
    expect(result.code, seed).toBe(0)
  }
})

test('--porcelain prints only a parseable run id on a successful dispatch', async () => {
  const result = await command(['do', 'file-question', 'inspect', '--porcelain'], { detach: async () => 73 })
  expect(result.ids).toEqual([73])
  expect(result.errors).toEqual([])
})

test('an implement contract conflict names the started run on stderr', async () => {
  const result = await command(['do', 'implement', 'Then push the branch.'], {
    readPrompt: async () => 'Then push the branch.', contractConflicts: () => [{ line: 1, text: 'push' }], detach: async () => 74,
  })
  expect(result.ids).toEqual([74])
  expect(result.conflicts).toEqual([[{ line: 1, text: 'push' }]])
})

test('--porcelain with an implement contract conflict still prints only the run id', async () => {
  const result = await command(['do', 'implement', 'push', '--porcelain'], {
    contractConflicts: () => [{ line: 1, text: 'push' }], detach: async () => 75,
  })
  expect(result.ids).toEqual([75]); expect(result.conflicts).toEqual([])
})

test('--porcelain refuses --follow because following cannot print only an id', async () => {
  const result = await command(['do', 'file-question', 'inspect', '--porcelain', '--follow'])
  expect(result.error).toContain('--porcelain cannot be combined with --follow')
})

test('a Codex schema rejected in preflight leaves no run row', async () => {
  const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
  const result = await command(['do', 'file-question', 'inspect', '--schema', '/bad/schema'], {
    validateSchema: () => { throw new Error('schema rejected') },
  })
  expect(result.error).toContain('schema rejected')
  expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
})

test('a drifted caller is signalled once before a fan-out, while an up-to-date one is quiet', async () => {
  let warnings = 0
  const result = await command(['do', 'understand', 'inspect'], { warnCallerDrift: () => { warnings++ } })
  expect(result.code).toBe(0); expect(warnings).toBe(1)
  warnings = 0
  await command(['do', 'summarize', 'inspect'], { warnCallerDrift: () => { warnings++ } })
  expect(warnings).toBe(0)
})

test('a drifted caller still dispatches, and --porcelain still prints only the run id', async () => {
  let warned = false
  const result = await command(['do', 'understand', 'inspect', '--porcelain'], {
    warnCallerDrift: () => { warned = true }, detach: async () => 76,
  })
  expect(warned).toBe(true); expect(result.ids).toEqual([76])
})
