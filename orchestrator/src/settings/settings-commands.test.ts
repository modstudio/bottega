import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { installRecordSessionRunner } from '../../test/fixtures/record-session.ts'
import { db } from '../database/db.ts'
import { getDoc, setDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberHostedRecord } from '../record/install-binding.ts'
import { serializeOwnedSettings } from './settings.ts'
import {
  settingsImportCommand,
  settingsPermissionCommand,
  settingsRenderCheckCommand,
} from './settings-commands.ts'

const roots: string[] = []
const priorHome = process.env.HOME
const priorApiUrl = process.env.ORCH_RECORD_API_URL
afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME
  else process.env.HOME = priorHome
  if (priorApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
  else process.env.ORCH_RECORD_API_URL = priorApiUrl
  installRecordSessionRunner(null)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureProject(name: string) {
  const root = mkdtempSync(join(tmpdir(), `settings-${name}-`))
  roots.push(root)
  process.env.HOME = root
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    `${JSON.stringify(
      {
        env: { SECRET: 'no' },
        permissions: { allow: ['Bash(orch result *)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash' }] },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(root, '.claude', 'settings.local.json'),
    `${JSON.stringify({ permissions: { allow: ['Bash(orch inbox*)'], ask: ['Bash(git *)'] } }, null, 2)}\n`,
  )
  upsertProject({
    name,
    path: root,
    stack: null,
    canon: true,
    settings: { managedContext: true },
  })
  return root
}

function presentation() {
  const logs: string[] = []
  let code = 0
  return {
    logs,
    cwd: () => '',
    flags: (extra: Record<string, string | boolean> = {}) => {
      const values = new Map<string, string | boolean>(Object.entries(extra))
      return {
        has: (name: string) => values.get(name) === true || typeof values.get(name) === 'string',
        flag: (name: string) => {
          const value = values.get(name)
          return typeof value === 'string' ? value : undefined
        },
      }
    },
    port: (cwd: string) => ({
      log: (...parts: unknown[]) => logs.push(parts.join(' ')),
      cwd: () => cwd,
      exitCode: (next: number) => {
        code = next
      },
    }),
    code: () => code,
  }
}

describe('settings import', () => {
  test('a bound install without an endpoint refuses a user write before identity side effects', async () => {
    const root = fixtureProject('bound-user')
    delete process.env.ORCH_RECORD_API_URL
    rememberHostedRecord()

    let keychainCalls = 0
    installRecordSessionRunner(() => {
      keychainCalls += 1
      throw new Error('unexpected keychain access')
    })
    const apiCalls: string[] = []
    const client = createMemoryRecordApiClient()
    installRecordApiClient({
      ...client,
      whoami: async () => {
        apiCalls.push('whoami')
        throw new Error('unexpected hosted identity lookup')
      },
      upsertDoc: async (input) => {
        apiCalls.push('upsertDoc')
        return client.upsertDoc(input)
      },
    })
    const metadataBefore = db()
      .query<{ key: string; value: string }, []>('SELECT key, value FROM schema_meta ORDER BY key')
      .all()

    await expect(
      settingsImportCommand(presentation().flags({ user: true }), presentation().port(root)),
    ).rejects.toThrow(/bound to a hosted record[\s\S]*orch record doctor/)

    expect(keychainCalls).toBe(0)
    expect(apiCalls).toEqual([])
    expect(
      db()
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM doc WHERE scope='settings'")
        .get()?.count,
    ).toBe(0)
    expect(
      db()
        .query<{ key: string; value: string }, []>(
          'SELECT key, value FROM schema_meta ORDER BY key',
        )
        .all(),
    ).toEqual(metadataBefore)
  })

  test('extracts only owned keys into the store', async () => {
    const root = fixtureProject('alpha')
    const shown = presentation()
    await settingsImportCommand(shown.flags({ project: 'alpha', 'dry-run': true }), {
      ...shown.port(root),
    })
    expect(shown.logs.join('\n')).toContain('permissions.allow: 1')
    expect(shown.logs.join('\n')).toContain('adoption')
    expect(shown.logs.join('\n')).toContain('Bash(orch inbox*)')
    expect(shown.logs.join('\n')).not.toContain('SECRET')
    expect(getDoc('settings', 'alpha', 'settings')).toBeNull()

    await settingsImportCommand(shown.flags({ project: 'alpha' }), shown.port(root))
    const stored = getDoc('settings', 'alpha', 'settings')
    expect(stored?.body).toBe(
      serializeOwnedSettings({
        permissions: { allow: ['Bash(orch result *)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash' }] },
      }),
    )
    expect(stored?.body).not.toContain('SECRET')
    expect(stored?.delivery).toBe('demand')
    await expect(
      setDoc({
        scope: 'settings',
        subject: 'alpha',
        slug: 'settings',
        title: 'settings',
        body: JSON.stringify({ permissions: {}, hooks: {}, env: { X: '1' } }),
        reason: 'reject extra keys',
        expectedRevision: stored!.revision!,
      }),
    ).rejects.toThrow(/unknown or missing/)
  })

  test('bootstraps only when the store has no row', async () => {
    const root = fixtureProject('beta')
    await settingsImportCommand(
      {
        has: (name) => name === 'project',
        flag: (name) => (name === 'project' ? 'beta' : undefined),
      },
      presentation().port(root),
    )
    const shown = presentation()
    await settingsImportCommand(
      {
        has: (name) => name === 'project' || name === 'dry-run',
        flag: (name) => (name === 'project' ? 'beta' : undefined),
      },
      shown.port(root),
    )
    expect(shown.logs.join('\n')).toContain('already exists')
    expect(shown.code()).toBe(1)
  })

  test('refuses an unparseable file', async () => {
    const root = fixtureProject('gamma')
    writeFileSync(join(root, '.claude', 'settings.json'), '{')
    await expect(
      settingsImportCommand(
        {
          has: (name) => name === 'project',
          flag: (name) => (name === 'project' ? 'gamma' : undefined),
        },
        presentation().port(root),
      ),
    ).rejects.toThrow(/cannot parse JSON/)
  })

  test('refuses a sentinel credential in a hook command and never prints it', async () => {
    const root = fixtureProject('secret-hook')
    const credential = ['Bearer ', 'z'.repeat(24)].join('')
    const command = `curl -H "Authorization: ${credential}" https://example.invalid`
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      `${JSON.stringify(
        {
          permissions: { allow: ['Bash(orch result *)'] },
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }],
          },
        },
        null,
        2,
      )}\n`,
    )
    const shown = presentation()
    await expect(
      settingsImportCommand(shown.flags({ project: 'secret-hook' }), shown.port(root)),
    ).rejects.toThrow(/secret-shaped material at hooks\.PreToolUse\[0\]\.hooks\[0\]\.command/)
    const output = shown.logs.join('\n')
    expect(output).not.toContain(credential)
    expect(output).not.toContain(command)
    expect(getDoc('settings', 'secret-hook', 'settings')).toBeNull()
  })

  test('imports a clean hook command', async () => {
    const root = fixtureProject('clean-hook')
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      `${JSON.stringify(
        {
          permissions: { allow: ['Bash(orch result *)'] },
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'orch note' }] }],
          },
        },
        null,
        2,
      )}\n`,
    )
    await settingsImportCommand(shownFlags('clean-hook'), presentation().port(root))
    const stored = getDoc('settings', 'clean-hook', 'settings')
    expect(stored?.body).toContain('orch note')
    expect(stored?.body).not.toContain('SECRET')
  })
})

describe('settings render --check', () => {
  test('json output redacts hook command text behind its fingerprint', async () => {
    const root = fixtureProject('json-redaction')
    const sentinel = 'DO_NOT_PRINT_THIS_HOOK_COMMAND'
    await setDoc({
      scope: 'settings',
      subject: 'json-redaction',
      slug: 'settings',
      title: 'settings',
      body: serializeOwnedSettings({
        permissions: { allow: ['Bash(orch result *)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: sentinel }] }],
        },
      }),
      reason: 'seed json redaction',
    })
    const shown = presentation()
    await settingsRenderCheckCommand(
      shown.flags({ project: 'json-redaction', check: true, json: true }),
      shown.port(root),
    )
    const output = shown.logs.join('\n')
    const parsed = JSON.parse(output)
    expect(output).not.toContain(sentinel)
    expect(parsed.settings.hooks[0]).toEqual(
      expect.objectContaining({ event: 'PreToolUse', matcher: 'Bash' }),
    )
    expect(parsed.settings.hooks[0].fingerprint).toMatch(/^[0-9a-f]{12}$/)
  })

  test('reports drift both ways', async () => {
    const root = fixtureProject('delta')
    await setDoc({
      scope: 'settings',
      subject: 'delta',
      slug: 'settings',
      title: 'settings',
      body: serializeOwnedSettings({
        permissions: { allow: ['Bash(orch result *)', 'Bash(orch diff *)'] },
        hooks: {},
      }),
      reason: 'seed store',
    })
    const shown = presentation()
    await settingsRenderCheckCommand(
      {
        has: (name) => name === 'project' || name === 'check',
        flag: (name) => (name === 'project' ? 'delta' : undefined),
      },
      shown.port(root),
    )
    const text = shown.logs.join('\n')
    expect(text).toContain('removed allow Bash(orch diff *)')
    expect(text).toContain('added hook PreToolUse')
    expect(text).not.toContain('"matcher"')
    expect(shown.code()).toBe(1)
  })

  test('a defaultMode-only difference is drift', async () => {
    const root = fixtureProject('default-mode')
    await setDoc({
      scope: 'settings',
      subject: 'default-mode',
      slug: 'settings',
      title: 'settings',
      body: serializeOwnedSettings({
        permissions: { allow: ['Bash(orch result *)'], defaultMode: 'acceptEdits' },
        hooks: { PreToolUse: [{ matcher: 'Bash' }] },
      }),
      reason: 'seed store',
    })
    const shown = presentation()
    await settingsRenderCheckCommand(
      shown.flags({ project: 'default-mode', check: true }),
      shown.port(root),
    )
    expect(shown.logs.join('\n')).not.toContain('drift: none')
    expect(shown.logs.join('\n')).toContain('owned settings structure differs')
    expect(shown.code()).toBe(1)
  })

  test('a file-only additionalDirectories is drift', async () => {
    const root = fixtureProject('extra-dirs')
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      `${JSON.stringify(
        {
          permissions: {
            allow: ['Bash(orch result *)'],
            additionalDirectories: ['src'],
          },
          hooks: { PreToolUse: [{ matcher: 'Bash' }] },
        },
        null,
        2,
      )}\n`,
    )
    await setDoc({
      scope: 'settings',
      subject: 'extra-dirs',
      slug: 'settings',
      title: 'settings',
      body: serializeOwnedSettings({
        permissions: { allow: ['Bash(orch result *)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash' }] },
      }),
      reason: 'seed store',
    })
    const shown = presentation()
    await settingsRenderCheckCommand(
      shown.flags({ project: 'extra-dirs', check: true }),
      shown.port(root),
    )
    expect(shown.logs.join('\n')).not.toContain('drift: none')
    expect(shown.logs.join('\n')).toContain('owned settings structure differs')
    expect(shown.code()).toBe(1)
  })

  test('hooks that differ only in key order are not drift', async () => {
    const root = fixtureProject('hook-order')
    const hook = { matcher: 'Bash', type: 'command', command: 'orch note' }
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      `${JSON.stringify(
        {
          permissions: { allow: ['Bash(orch result *)'] },
          hooks: { PreToolUse: [hook] },
        },
        null,
        2,
      )}\n`,
    )
    await setDoc({
      scope: 'settings',
      subject: 'hook-order',
      slug: 'settings',
      title: 'settings',
      body: serializeOwnedSettings({
        permissions: { allow: ['Bash(orch result *)'] },
        hooks: { PreToolUse: [{ type: 'command', command: 'orch note', matcher: 'Bash' }] },
      }),
      reason: 'seed store',
    })
    const shown = presentation()
    await settingsRenderCheckCommand(
      shown.flags({ project: 'hook-order', check: true }),
      shown.port(root),
    )
    expect(shown.logs.join('\n')).toContain('drift: none')
    expect(shown.logs.join('\n')).not.toContain('orch note')
    expect(shown.code()).toBe(0)
  })

  test('drift output fingerprints hooks and never prints commands', async () => {
    const root = fixtureProject('hook-print')
    const command = 'orch note'
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      `${JSON.stringify(
        {
          permissions: { allow: ['Bash(orch result *)'] },
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }],
          },
        },
        null,
        2,
      )}\n`,
    )
    await setDoc({
      scope: 'settings',
      subject: 'hook-print',
      slug: 'settings',
      title: 'settings',
      body: serializeOwnedSettings({
        permissions: { allow: ['Bash(orch result *)'] },
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'hub task' }] }],
        },
      }),
      reason: 'seed store',
    })
    const shown = presentation()
    await settingsRenderCheckCommand(
      shown.flags({ project: 'hook-print', check: true }),
      shown.port(root),
    )
    const text = shown.logs.join('\n')
    expect(text).toMatch(/added hook PreToolUse Bash [0-9a-f]{12}/)
    expect(text).toMatch(/removed hook SessionStart \* [0-9a-f]{12}/)
    expect(text).not.toContain(command)
    expect(text).not.toContain('hub task')
    expect(shown.code()).toBe(1)
  })
})

function shownFlags(project: string) {
  return {
    has: (name: string) => name === 'project',
    flag: (name: string) => (name === 'project' ? project : undefined),
  }
}

function urlUserinfoSentinel() {
  return ['https://user', ':pass@', 'host.example'].join('')
}

test('setDoc refuses a sentinel before any hosted call or local row', async () => {
  fixtureProject('setdoc-secret')
  const captured: unknown[] = []
  const inner = createMemoryRecordApiClient()
  installRecordApiClient({
    ...inner,
    upsertDoc: async (input) => {
      captured.push(input)
      return inner.upsertDoc(input)
    },
  })
  const sentinel = urlUserinfoSentinel()
  await expect(
    setDoc({
      scope: 'settings',
      subject: 'setdoc-secret',
      slug: 'settings',
      title: 'settings',
      body: serializeOwnedSettings({ permissions: { allow: [sentinel] }, hooks: {} }),
      reason: 'inject sentinel',
    }),
  ).rejects.toThrow(/secret-shaped material at permissions\.allow\[0\]/)
  expect(captured).toEqual([])
  expect(getDoc('settings', 'setdoc-secret', 'settings')).toBeNull()
})

test('render drift containing a sentinel rule prints no sentinel', async () => {
  const root = fixtureProject('drift-secret')
  const sentinel = urlUserinfoSentinel()
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    `${JSON.stringify(
      {
        permissions: { allow: [sentinel] },
        hooks: { PreToolUse: [{ matcher: 'Bash' }] },
      },
      null,
      2,
    )}\n`,
  )
  await setDoc({
    scope: 'settings',
    subject: 'drift-secret',
    slug: 'settings',
    title: 'settings',
    body: serializeOwnedSettings({
      permissions: { allow: ['Bash(orch result *)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash' }] },
    }),
    reason: 'seed store',
  })
  const shown = presentation()
  await settingsRenderCheckCommand(
    shown.flags({ project: 'drift-secret', check: true }),
    shown.port(root),
  )
  const text = shown.logs.join('\n')
  expect(text).toMatch(/permissions\.allow\[0\] [0-9a-f]{12} secret-shaped/)
  expect(text).not.toContain(sentinel)
  expect(shown.code()).toBe(1)
})

test('adoption output containing a sentinel prints no sentinel', async () => {
  const root = fixtureProject('adopt-secret')
  const sentinel = urlUserinfoSentinel()
  writeFileSync(
    join(root, '.claude', 'settings.local.json'),
    `${JSON.stringify({ permissions: { allow: [sentinel] } }, null, 2)}\n`,
  )
  const shown = presentation()
  await settingsImportCommand(shown.flags({ project: 'adopt-secret', 'dry-run': true }), {
    ...shown.port(root),
  })
  const text = shown.logs.join('\n')
  expect(text).toMatch(/permissions\.allow\[0\] [0-9a-f]{12} secret-shaped/)
  expect(text).not.toContain(sentinel)
  expect(getDoc('settings', 'adopt-secret', 'settings')).toBeNull()
})

describe('settings permission', () => {
  test('refuses unknown and unmanaged projects', async () => {
    const shown = presentation()
    await expect(
      settingsPermissionCommand(
        shown.flags({
          project: 'missing',
          list: 'allow',
          rule: 'Bash(orch *)',
          expect: 'revision-1',
        }),
        'add',
      ),
    ).rejects.toThrow('unknown project "missing"')

    const root = fixtureProject('unmanaged-permissions')
    upsertProject({
      name: 'unmanaged-permissions',
      path: root,
      stack: null,
      canon: true,
      settings: { managedContext: false },
    })
    await expect(
      settingsPermissionCommand(
        shown.flags({
          project: 'unmanaged-permissions',
          list: 'allow',
          rule: 'Bash(orch *)',
          expect: 'revision-1',
        }),
        'add',
      ),
    ).rejects.toThrow('does not have managedContext on')
  })

  test('requires a revision and refuses remove when the row is missing', async () => {
    const root = fixtureProject('permission-missing')
    const shown = presentation()
    await expect(
      settingsPermissionCommand(
        shown.flags({ project: 'permission-missing', list: 'allow', rule: 'Bash(orch *)' }),
        'add',
      ),
    ).rejects.toThrow('--expect is required')
    await expect(
      settingsPermissionCommand(
        shown.flags({
          project: 'permission-missing',
          list: 'allow',
          rule: 'Bash(orch *)',
          expect: 'revision-1',
        }),
        'remove',
      ),
    ).rejects.toThrow('no settings row for permission-missing')
    expect(getDoc('settings', 'permission-missing', 'settings')).toBeNull()
    expect(root).toBeTruthy()
  })

  test('add is idempotent and an absent remove writes no revision', async () => {
    fixtureProject('permission-idempotent')
    const seeded = await setDoc({
      scope: 'settings',
      subject: 'permission-idempotent',
      slug: 'settings',
      title: 'settings',
      body: serializeOwnedSettings({
        permissions: { allow: ['Bash(orch *)'] },
        hooks: {},
      }),
      delivery: 'demand',
      reason: 'seed settings',
    })
    const shown = presentation()
    const input = {
      project: 'permission-idempotent',
      list: 'allow',
      rule: 'Bash(orch *)',
      expect: seeded.revision!,
    }
    const duplicate = await settingsPermissionCommand(shown.flags(input), 'add')
    expect(duplicate).toMatchObject({ changed: false, message: 'already present' })
    expect(getDoc('settings', 'permission-idempotent', 'settings')?.revision).toBe(seeded.revision)

    const absent = await settingsPermissionCommand(
      shown.flags({ ...input, rule: 'Bash(git *)' }),
      'remove',
    )
    expect(absent).toMatchObject({ changed: false, message: 'rule is absent' })
    expect(getDoc('settings', 'permission-idempotent', 'settings')?.revision).toBe(seeded.revision)

    const added = await settingsPermissionCommand(
      shown.flags({ ...input, rule: 'Bash(git *)', reason: 'allow git' }),
      'add',
    )
    expect(added).toMatchObject({ changed: true, counts: { allow: 2, ask: 0, deny: 0 } })
    expect(added.revision).not.toBe(seeded.revision)
  })
})

describe('worker settings command refusals', () => {
  let priorRunId: string | undefined

  beforeEach(() => {
    priorRunId = process.env.ORCH_RUN_ID
    process.env.ORCH_RUN_ID = 'settings-worker'
  })

  afterEach(() => {
    if (priorRunId === undefined) delete process.env.ORCH_RUN_ID
    else process.env.ORCH_RUN_ID = priorRunId
  })

  test('settings import allows an architect caller and refuses a worker caller', async () => {
    const allowedRoot = fixtureProject('import-architect')
    delete process.env.ORCH_RUN_ID
    await settingsImportCommand(
      presentation().flags({ project: 'import-architect' }),
      presentation().port(allowedRoot),
    )
    expect(getDoc('settings', 'import-architect', 'settings')).not.toBeNull()

    process.env.ORCH_RUN_ID = 'settings-worker'
    const refusedRoot = fixtureProject('import-worker')
    await expect(
      settingsImportCommand(
        presentation().flags({ project: 'import-worker' }),
        presentation().port(refusedRoot),
      ),
    ).rejects.toThrow('refusing document store write from an orch worker run')
    expect(getDoc('settings', 'import-worker', 'settings')).toBeNull()
  })

  test.each(['add', 'remove'] as const)(
    'settings permission %s allows an architect caller and refuses a worker caller',
    async (operation) => {
      const architect = `permission-${operation}-architect`
      const worker = `permission-${operation}-worker`
      fixtureProject(architect)
      fixtureProject(worker)
      delete process.env.ORCH_RUN_ID
      const architectDoc = await setDoc({
        scope: 'settings',
        subject: architect,
        slug: 'settings',
        title: 'settings',
        body: serializeOwnedSettings({
          permissions: { allow: operation === 'remove' ? ['Bash(git status)'] : [] },
          hooks: {},
        }),
        delivery: 'demand',
        reason: 'fixture',
      })
      const workerDoc = await setDoc({
        scope: 'settings',
        subject: worker,
        slug: 'settings',
        title: 'settings',
        body: serializeOwnedSettings({
          permissions: { allow: operation === 'remove' ? ['Bash(git status)'] : [] },
          hooks: {},
        }),
        delivery: 'demand',
        reason: 'fixture',
      })
      const rule = 'Bash(git status)'
      await settingsPermissionCommand(
        presentation().flags({
          project: architect,
          list: 'allow',
          rule,
          expect: architectDoc.revision!,
        }),
        operation,
      )

      process.env.ORCH_RUN_ID = 'settings-worker'
      await expect(
        settingsPermissionCommand(
          presentation().flags({
            project: worker,
            list: 'allow',
            rule,
            expect: workerDoc.revision!,
          }),
          operation,
        ),
      ).rejects.toThrow('refusing document store write from an orch worker run')
    },
  )
})
