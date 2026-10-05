import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import {
  installRecordSessionRunner,
  memoryRecordSession,
} from '../../test/fixtures/record-session.ts'
import { getDoc, setDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { parseStoredOwnedSettings, serializeOwnedSettings } from './settings.ts'
import {
  settingsAdoptCommand,
  settingsEnvImportCommand,
  settingsRenderWriteCommand,
} from './settings-apply-commands.ts'
import { settingsRenderCheckCommand } from './settings-commands.ts'

const OWNER = '01990000-0000-7000-8000-000000000001'
const priorHome = process.env.HOME
const priorState = process.env.BOTTEGA_STATE_HOME
const priorApiUrl = process.env.ORCH_RECORD_API_URL
let root = ''
let claude = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'settings-apply-'))
  claude = join(root, '.claude')
  mkdirSync(claude)
  process.env.HOME = root
  process.env.BOTTEGA_STATE_HOME = join(root, 'state')
  process.env.ORCH_RECORD_API_URL = 'https://record-api.example.test'
  const session = memoryRecordSession()
  session.setToken('fixture-session')
  installRecordSessionRunner(session.runner)
})

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME
  else process.env.HOME = priorHome
  if (priorState === undefined) delete process.env.BOTTEGA_STATE_HOME
  else process.env.BOTTEGA_STATE_HOME = priorState
  if (priorApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
  else process.env.ORCH_RECORD_API_URL = priorApiUrl
  installRecordSessionRunner(null)
  rmSync(root, { recursive: true, force: true })
})

function flags(values: Record<string, string | string[] | boolean>) {
  return {
    has: (name: string) => Boolean(values[name]),
    flag: (name: string) => (typeof values[name] === 'string' ? String(values[name]) : undefined),
    values: (name: string) => {
      const value = values[name]
      return Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : []
    },
  }
}

function shown(cwd = root) {
  const logs: string[] = []
  let code = 0
  return {
    logs,
    code: () => code,
    port: {
      log: (...values: unknown[]) => logs.push(values.join(' ')),
      exitCode: (value: number) => {
        code = value
      },
      cwd: () => cwd,
    },
  }
}

async function seedUser() {
  await setDoc({
    scope: 'settings',
    subject: null,
    owner: OWNER,
    slug: 'settings',
    title: 'settings',
    body: serializeOwnedSettings({ permissions: {}, hooks: {}, envKeys: [] }),
    delivery: 'demand',
    reason: 'fixture',
  })
}

describe('settings env import', () => {
  test('never sends or prints a sentinel value', async () => {
    const sentinel = 'sentinel-env-value-that-must-not-escape'
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ env: { API_TOKEN: sentinel } }))
    const captured: unknown[] = []
    const inner = createMemoryRecordApiClient()
    installRecordApiClient({
      ...inner,
      upsertDoc: async (input) => {
        captured.push(input)
        return inner.upsertDoc(input)
      },
    })
    await seedUser()
    captured.length = 0
    const output = shown()
    await settingsEnvImportCommand(flags({ user: true }), output.port)
    const stored = getDoc('settings', null, 'settings', OWNER)
    expect(parseStoredOwnedSettings(stored!.body).envKeys).toEqual(['API_TOKEN'])
    expect(JSON.stringify(captured)).not.toContain(sentinel)
    expect(stored!.body).not.toContain(sentinel)
    expect(output.logs.join('\n')).not.toContain(sentinel)
    expect(output.logs.join('\n')).toContain('API_TOKEN')

    const extra = 'another-sentinel-value-that-must-not-escape'
    writeFileSync(
      join(claude, 'settings.json'),
      JSON.stringify({ env: { API_TOKEN: sentinel, EXTRA: extra }, permissions: {}, hooks: {} }),
    )
    const drift = shown()
    await settingsRenderCheckCommand(flags({ user: true, check: true }), drift.port)
    expect(drift.logs.join('\n')).toContain('added env key EXTRA')
    expect(drift.logs.join('\n')).not.toContain(sentinel)
    expect(drift.logs.join('\n')).not.toContain(extra)
  })

  test('refuses a project env target', async () => {
    await expect(
      settingsEnvImportCommand(flags({ project: 'fixture' }), shown().port),
    ).rejects.toThrow(/project settings are tracked in git/)
  })

  test('malformed JSON never exposes a sentinel in command output or error', async () => {
    const sentinel = 'sentinel-malformed-command-value'
    writeFileSync(join(claude, 'settings.json'), `{"env":{"TOKEN":"${sentinel}"}`)
    await seedUser()
    const output = shown()
    let message = ''
    try {
      await settingsEnvImportCommand(flags({ user: true }), output.port)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('cannot parse JSON')
    expect(message).not.toContain(sentinel)
    expect(output.logs.join('\n')).not.toContain(sentinel)
  })
})

describe('settings render write', () => {
  test('without --yes prints a names-and-counts plan and writes nothing', async () => {
    writeFileSync(
      join(claude, 'settings.json'),
      `${JSON.stringify({ env: { OLD_KEY: 'private' }, permissions: {}, hooks: {} }, null, 2)}\n`,
    )
    writeFileSync(join(claude, 'settings.env'), 'OLD_KEY="private"\n', { mode: 0o600 })
    await seedUser()
    const before = readFileSync(join(claude, 'settings.json'), 'utf8')
    const output = shown()
    await settingsRenderWriteCommand(flags({ user: true, write: true }), output.port)
    expect(output.code()).toBe(1)
    expect(readFileSync(join(claude, 'settings.json'), 'utf8')).toBe(before)
    expect(output.logs.join('\n')).toContain('env keys removed: 1 OLD_KEY')
    expect(output.logs.join('\n')).not.toContain('private')
  })

  test('refuses a registered project main checkout', async () => {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), '{}\n')
    upsertProject({
      name: 'main-fixture',
      path: root,
      stack: null,
      canon: true,
      settings: { managedContext: true },
    })
    await setDoc({
      scope: 'settings',
      subject: 'main-fixture',
      slug: 'settings',
      title: 'settings',
      body: serializeOwnedSettings({ permissions: {}, hooks: {}, envKeys: [] }),
      reason: 'fixture',
    })
    await expect(
      settingsRenderWriteCommand(
        flags({ project: 'main-fixture', write: true, yes: true }),
        shown(root).port,
      ),
    ).rejects.toThrow(/registered main checkout.*commit the settings change, and land it/s)
  })

  test('protects env values until imported and permits an explicit drop', async () => {
    const settings = join(claude, 'settings.json')
    writeFileSync(
      settings,
      `${JSON.stringify({ env: { ONLY_HERE: 'private' }, permissions: {}, hooks: {} }, null, 2)}\n`,
    )
    await seedUser()
    await expect(
      settingsRenderWriteCommand(flags({ user: true, write: true, yes: true }), shown().port),
    ).rejects.toThrow(/ONLY_HERE.*settings env import --user.*--drop-env ONLY_HERE/s)

    await settingsEnvImportCommand(flags({ user: true }), shown().port)
    await settingsRenderWriteCommand(flags({ user: true, write: true, yes: true }), shown().port)
    expect(JSON.parse(readFileSync(settings, 'utf8')).env).toEqual({ ONLY_HERE: 'private' })

    await setDoc({
      scope: 'settings',
      subject: null,
      owner: OWNER,
      slug: 'settings',
      title: 'settings',
      body: serializeOwnedSettings({ permissions: {}, hooks: {}, envKeys: [] }),
      delivery: 'demand',
      reason: 'drop fixture',
      expectedRevision: getDoc('settings', null, 'settings', OWNER)!.revision!,
    })
    await settingsRenderWriteCommand(
      flags({ user: true, write: true, yes: true, 'drop-env': 'ONLY_HERE' }),
      shown().port,
    )
    expect(JSON.parse(readFileSync(settings, 'utf8')).env).toEqual({})
  })
})

describe('settings adopt', () => {
  test('adds matching lists and leaves settings.local.json untouched', async () => {
    const local = join(claude, 'settings.local.json')
    const localText = `${JSON.stringify(
      {
        permissions: {
          allow: ['Bash(orch result *)'],
          ask: ['Bash(git status)'],
          deny: ['Read(.env)'],
        },
      },
      null,
      2,
    )}\n`
    writeFileSync(local, localText)
    await seedUser()
    const output = shown()
    await settingsAdoptCommand(flags({ user: true, all: true }), [], output.port)
    const stored = parseStoredOwnedSettings(getDoc('settings', null, 'settings', OWNER)!.body)
    expect(stored.permissions).toEqual({
      allow: ['Bash(orch result *)'],
      ask: ['Bash(git status)'],
      deny: ['Read(.env)'],
    })
    expect(readFileSync(local, 'utf8')).toBe(localText)
    expect(output.logs.join('\n')).toContain('adopted: 3')
  })

  test('does not create empty permission lists', async () => {
    const local = join(claude, 'settings.local.json')
    writeFileSync(local, JSON.stringify({ permissions: { allow: ['Bash(git status)'] } }))
    await seedUser()
    await settingsAdoptCommand(flags({ user: true, all: true }), [], shown().port)
    const stored = parseStoredOwnedSettings(getDoc('settings', null, 'settings', OWNER)!.body)
    expect(stored.permissions).toEqual({ allow: ['Bash(git status)'] })
  })
})

describe('worker settings apply refusals', () => {
  let priorRunId: string | undefined

  beforeEach(() => {
    priorRunId = process.env.ORCH_RUN_ID
    process.env.ORCH_RUN_ID = 'settings-apply-worker'
  })

  afterEach(() => {
    if (priorRunId === undefined) delete process.env.ORCH_RUN_ID
    else process.env.ORCH_RUN_ID = priorRunId
  })

  test('settings env-import allows an architect caller and refuses a worker caller', async () => {
    delete process.env.ORCH_RUN_ID
    await seedUser()
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ env: { FIRST: 'private' } }))
    await settingsEnvImportCommand(flags({ user: true }), shown().port)
    expect(
      parseStoredOwnedSettings(getDoc('settings', null, 'settings', OWNER)!.body).envKeys,
    ).toEqual(['FIRST'])

    writeFileSync(
      join(claude, 'settings.json'),
      JSON.stringify({ env: { FIRST: 'private', SECOND: 'private' } }),
    )
    process.env.ORCH_RUN_ID = 'settings-apply-worker'
    await expect(settingsEnvImportCommand(flags({ user: true }), shown().port)).rejects.toThrow(
      'refusing document store write from an orch worker run',
    )
  })

  test('settings render --write refuses a worker caller', async () => {
    await expect(
      settingsRenderWriteCommand(flags({ user: true, write: true, yes: true }), shown().port),
    ).rejects.toThrow(
      'refusing settings render --write from an orch worker run; an operator must run orch settings render --write',
    )
  })

  test('settings adopt allows an architect caller and refuses a worker caller', async () => {
    delete process.env.ORCH_RUN_ID
    await seedUser()
    const local = join(claude, 'settings.local.json')
    writeFileSync(local, JSON.stringify({ permissions: { allow: ['Bash(git status)'] } }))
    await settingsAdoptCommand(flags({ user: true, all: true }), [], shown().port)
    expect(
      parseStoredOwnedSettings(getDoc('settings', null, 'settings', OWNER)!.body).permissions,
    ).toEqual({ allow: ['Bash(git status)'] })

    writeFileSync(
      local,
      JSON.stringify({ permissions: { allow: ['Bash(git status)', 'Bash(git diff)'] } }),
    )
    process.env.ORCH_RUN_ID = 'settings-apply-worker'
    await expect(
      settingsAdoptCommand(flags({ user: true, all: true }), [], shown().port),
    ).rejects.toThrow('refusing document store write from an orch worker run')
  })
})
