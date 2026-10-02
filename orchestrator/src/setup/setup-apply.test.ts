import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { applySetupActions } from './setup-apply.ts'
import type { SetupAction } from './setup-planner.ts'
import { INFERRED_RECIPE_PATH } from './setup-toolchain.ts'

const action = (name: string): SetupAction => ({
  kind: 'add',
  name,
  path: `/repos/${name}`,
  stack: null,
  settings: {},
  settingsDiff: {},
})

const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('writes an inferred recipe before filling its absent register pointer and never overwrites', async () => {
  const path = mkdtempSync(join(tmpdir(), 'setup-apply-'))
  temporary.push(path)
  const candidate: SetupAction = {
    kind: 'set',
    currentName: 'project',
    path,
    fill: { settings: { worktree: { recipePath: INFERRED_RECIPE_PATH } } },
    settingsDiff: {},
    recipeFile: { path: INFERRED_RECIPE_PATH, content: '{"worktree":{"create":[]}}\n' },
  }
  let filled = false
  const service = {
    add: async () => {},
    fillAbsent: async () => {
      expect(existsSync(join(path, INFERRED_RECIPE_PATH))).toBe(true)
      filled = true
    },
  }
  expect((await applySetupActions([candidate], service))[0]?.status).toBe('applied')
  expect(filled).toBe(true)
  expect(readFileSync(join(path, INFERRED_RECIPE_PATH), 'utf8')).toContain('create')

  writeFileSync(join(path, INFERRED_RECIPE_PATH), 'owned by user')
  const repeated = await applySetupActions([candidate], service)
  expect(repeated[0]?.status).toBe('refused')
  expect(readFileSync(join(path, INFERRED_RECIPE_PATH), 'utf8')).toBe('owned by user')
})

test('removes the recipe it created when the register fill is refused', async () => {
  const path = mkdtempSync(join(tmpdir(), 'setup-apply-refused-'))
  temporary.push(path)
  const candidate: SetupAction = {
    kind: 'set',
    currentName: 'project',
    path,
    fill: { settings: { worktree: { recipePath: INFERRED_RECIPE_PATH } } },
    settingsDiff: {},
    recipeFile: { path: INFERRED_RECIPE_PATH, content: '{"worktree":{"create":[]}}\n' },
  }
  const results = await applySetupActions([candidate], {
    add: async () => {},
    fillAbsent: async () => {
      throw new Error('recipePath is no longer absent')
    },
  })
  expect(results[0]?.status).toBe('refused')
  expect(results[0]?.message).toContain('recipePath is no longer absent')
  expect(existsSync(join(path, INFERRED_RECIPE_PATH))).toBe(false)
})

test('removes the recipe it created when project registration is refused', async () => {
  const path = mkdtempSync(join(tmpdir(), 'setup-apply-add-refused-'))
  temporary.push(path)
  const candidate: SetupAction = {
    kind: 'add',
    name: 'project',
    path,
    stack: 'node',
    settings: { worktree: { recipePath: INFERRED_RECIPE_PATH } },
    settingsDiff: {},
    recipeFile: { path: INFERRED_RECIPE_PATH, content: '{"worktree":{"create":[]}}\n' },
  }
  const results = await applySetupActions([candidate], {
    add: async () => {
      expect(existsSync(join(path, INFERRED_RECIPE_PATH))).toBe(true)
      throw new Error('project registration refused')
    },
    fillAbsent: async () => {},
  })
  expect(results[0]?.status).toBe('refused')
  expect(results[0]?.message).toContain('project registration refused')
  expect(existsSync(join(path, INFERRED_RECIPE_PATH))).toBe(false)
})

test('keeps a replacement when registration is refused after another writer replaced the recipe', async () => {
  const path = mkdtempSync(join(tmpdir(), 'setup-apply-replaced-'))
  temporary.push(path)
  const recipePath = join(path, INFERRED_RECIPE_PATH)
  const candidate: SetupAction = {
    kind: 'set',
    currentName: 'project',
    path,
    fill: { settings: { worktree: { recipePath: INFERRED_RECIPE_PATH } } },
    settingsDiff: {},
    recipeFile: { path: INFERRED_RECIPE_PATH, content: 'created by setup' },
  }
  const results = await applySetupActions([candidate], {
    add: async () => {},
    fillAbsent: async () => {
      unlinkSync(recipePath)
      writeFileSync(recipePath, 'replacement')
      throw new Error('registration refused')
    },
  })
  expect(results[0]?.status).toBe('refused')
  expect(results[0]?.message).toContain('identity or content changed')
  expect(readFileSync(recipePath, 'utf8')).toBe('replacement')
})

test('keeps the recipe when a hosted failure follows the committed local fill', async () => {
  const path = mkdtempSync(join(tmpdir(), 'setup-apply-hosted-'))
  temporary.push(path)
  const candidate: SetupAction = {
    kind: 'set',
    currentName: 'project',
    path,
    fill: { settings: { worktree: { recipePath: INFERRED_RECIPE_PATH } } },
    settingsDiff: {},
    recipeFile: { path: INFERRED_RECIPE_PATH, content: 'created by setup' },
  }
  let locallyCommitted = false
  const results = await applySetupActions([candidate], {
    add: async () => {},
    fillAbsent: async () => {
      locallyCommitted = true
      throw new Error('hosted write failed')
    },
    currentRecipePath: () => (locallyCommitted ? INFERRED_RECIPE_PATH : null),
  })
  expect(results[0]?.status).toBe('refused')
  expect(results[0]?.message).toContain('committed locally')
  expect(readFileSync(join(path, INFERRED_RECIPE_PATH), 'utf8')).toBe('created by setup')
})

test('refuses a symlinked recipe directory and writes nothing outside the repository', async () => {
  const path = mkdtempSync(join(tmpdir(), 'setup-apply-symlink-'))
  const outside = mkdtempSync(join(tmpdir(), 'setup-apply-outside-'))
  temporary.push(path, outside)
  symlinkSync(outside, join(path, dirname(INFERRED_RECIPE_PATH)))
  const candidate: SetupAction = {
    kind: 'set',
    currentName: 'project',
    path,
    fill: { settings: { worktree: { recipePath: INFERRED_RECIPE_PATH } } },
    settingsDiff: {},
    recipeFile: { path: INFERRED_RECIPE_PATH, content: '{"worktree":{"create":[]}}\n' },
  }
  let filled = false
  const results = await applySetupActions([candidate], {
    add: async () => {},
    fillAbsent: async () => {
      filled = true
    },
  })
  expect(results[0]?.status).toBe('refused')
  expect(results[0]?.message).toContain('symbolic link')
  expect(filled).toBe(false)
  expect(existsSync(join(outside, 'worktree-recipe.jsonc'))).toBe(false)
})

test('stops at the first refusal and marks remaining actions not attempted', async () => {
  const attempted: string[] = []
  const results = await applySetupActions([action('one'), action('two'), action('three')], {
    add: async (candidate) => {
      attempted.push(candidate.name)
      if (candidate.name === 'two') throw new Error('service refused two')
    },
    fillAbsent: async () => {},
  })
  expect(attempted).toEqual(['one', 'two'])
  expect(results.map((result) => result.status)).toEqual(['applied', 'refused', 'not-attempted'])
  expect(results[1]?.message).toBe('service refused two')
})

test('adds an MCP registration and verifies the read-back', async () => {
  const calls: string[][] = []
  let reads = 0
  const registration: SetupAction = {
    kind: 'register-mcp',
    harness: 'codex',
    bin: '/bin/codex',
    server: { name: 'orch', command: '/bin/orch', args: ['mcp'] },
    replace: false,
  }
  const results = await applySetupActions(
    [registration],
    { add: async () => {}, fillAbsent: async () => {} },
    (argv) => {
      calls.push(argv)
      return {
        stdout: argv.includes('get')
          ? ++reads === 1
            ? ''
            : JSON.stringify({
                transport: { type: 'stdio', command: '/bin/orch', args: ['mcp'] },
              })
          : 'added',
        stderr:
          argv.includes('get') && reads === 1 ? "Error: No MCP server named 'orch' found." : '',
        exitCode: argv.includes('get') && reads === 1 ? 1 : 0,
        timedOut: false,
        error: null,
      }
    },
  )
  expect(calls.map((argv) => argv.slice(1, 3))).toEqual([
    ['mcp', 'get'],
    ['mcp', 'add'],
    ['mcp', 'get'],
  ])
  expect(results[0]?.status).toBe('applied')
})

test('refuses a registration that became different before add and does not add', async () => {
  const registration: SetupAction = {
    kind: 'register-mcp',
    harness: 'codex',
    bin: '/bin/codex',
    server: { name: 'orch', command: '/bin/orch', args: ['mcp'] },
    replace: false,
  }
  const results = await applySetupActions(
    [registration, action('later')],
    { add: async () => {}, fillAbsent: async () => {} },
    (argv) => ({
      exitCode: 0,
      stdout: argv.includes('get')
        ? JSON.stringify({ transport: { type: 'stdio', command: '/wrong', args: [] } })
        : 'added',
      stderr: '',
      timedOut: false,
      error: null,
    }),
  )
  expect(results.map((result) => result.status)).toEqual(['refused', 'not-attempted'])
  expect(results[0]?.message).toContain('changed before add')
  expect(results[0]?.message).toContain('/wrong')
})

test('replaces a Claude MCP registration by removing, adding, then reading back', async () => {
  const calls: string[][] = []
  const results = await applySetupActions(
    [
      {
        kind: 'register-mcp',
        harness: 'claude',
        bin: '/bin/claude',
        server: { name: 'orch', command: '/bin/orch', args: ['mcp'] },
        replace: true,
      },
    ],
    { add: async () => {}, fillAbsent: async () => {} },
    (argv) => {
      calls.push(argv)
      return {
        exitCode: 0,
        stdout: argv.includes('get') ? 'Command: /bin/orch\nArgs: mcp\n' : 'ok',
        stderr: '',
        timedOut: false,
        error: null,
      }
    },
  )
  expect(calls.map((argv) => argv.slice(1, 3))).toEqual([
    ['mcp', 'remove'],
    ['mcp', 'add'],
    ['mcp', 'get'],
  ])
  expect(results[0]?.status).toBe('applied')
})

test('refuses a Claude replacement after a failed remove without attempting add', async () => {
  const calls: string[][] = []
  const results = await applySetupActions(
    [
      {
        kind: 'register-mcp',
        harness: 'claude',
        bin: '/bin/claude',
        server: { name: 'orch', command: '/bin/orch', args: ['mcp'] },
        replace: true,
      },
    ],
    { add: async () => {}, fillAbsent: async () => {} },
    (argv) => {
      calls.push(argv)
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'remove failed',
        timedOut: false,
        error: null,
      }
    },
  )
  expect(calls.map((argv) => argv.slice(1, 3))).toEqual([['mcp', 'remove']])
  expect(results[0]?.status).toBe('refused')
  expect(results[0]?.message).toContain('claude refused')
  expect(results[0]?.message).toContain('exit code 1')
})

test.each(['codex', 'grok'] as const)(
  '%s replacement adds once without removing before read-back',
  async (harness) => {
    const calls: string[][] = []
    const results = await applySetupActions(
      [
        {
          kind: 'register-mcp',
          harness,
          bin: `/bin/${harness}`,
          server: { name: 'orch', command: '/bin/orch', args: ['mcp'] },
          replace: true,
        },
      ],
      { add: async () => {}, fillAbsent: async () => {} },
      (argv) => {
        calls.push(argv)
        const stdout = argv.includes('get')
          ? JSON.stringify({ transport: { type: 'stdio', command: '/bin/orch', args: ['mcp'] } })
          : argv.includes('list')
            ? JSON.stringify([{ name: 'orch', command: '/bin/orch', args: ['mcp'] }])
            : 'ok'
        return { exitCode: 0, stdout, stderr: '', timedOut: false, error: null }
      },
    )
    expect(calls.filter((argv) => argv.includes('add'))).toHaveLength(1)
    expect(calls.some((argv) => argv.includes('remove'))).toBe(false)
    expect(results[0]?.status).toBe('applied')
  },
)

test('reports unchanged when a registration appears with the desired value before add', async () => {
  const calls: string[][] = []
  const results = await applySetupActions(
    [
      {
        kind: 'register-mcp',
        harness: 'codex',
        bin: '/bin/codex',
        server: { name: 'orch', command: '/bin/orch', args: ['mcp'] },
        replace: false,
      },
    ],
    { add: async () => {}, fillAbsent: async () => {} },
    (argv) => {
      calls.push(argv)
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          transport: { type: 'stdio', command: '/bin/orch', args: ['mcp'] },
        }),
        stderr: '',
        timedOut: false,
        error: null,
      }
    },
  )
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('get')
  expect(results[0]?.status).toBe('unchanged')
})

test('screens secret-shaped read-back and command output from refusal and apply JSON', async () => {
  const secret = 'API_TOKEN=sk-proj-do-not-render'
  let reads = 0
  const results = await applySetupActions(
    [
      {
        kind: 'register-mcp',
        harness: 'codex',
        bin: '/bin/codex',
        server: { name: 'orch', command: '/bin/orch', args: ['mcp'] },
        replace: false,
      },
    ],
    { add: async () => {}, fillAbsent: async () => {} },
    (argv) => {
      const isRead = argv.includes('get')
      if (isRead) reads++
      return {
        exitCode: isRead && reads === 1 ? 1 : 0,
        stdout:
          isRead && reads > 1
            ? JSON.stringify({
                transport: { type: 'stdio', command: '/wrong', args: [secret] },
              })
            : isRead
              ? ''
              : `added ${secret}`,
        stderr:
          isRead && reads === 1 ? "Error: No MCP server named 'orch' found." : `also raw ${secret}`,
        timedOut: false,
        error: null,
      }
    },
  )
  const json = JSON.stringify(results)
  expect(results[0]?.status).toBe('refused')
  expect(json).toContain('did not verify')
  expect(json).not.toContain(secret)
  expect(json).toContain('[withheld: secret-shaped]')
})
