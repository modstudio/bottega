import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordRouteClass } from '../../../shared/record-call-trace.ts'
import { resolveOrchestratorDatabase } from '../../../shared/state-directory.ts'
import { getDoc } from '../../test/fixtures/doc-local-read.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { USER_CANON_MANAGED_MARKER } from '../canon/user-canon-home.ts'
import { db } from '../database/db.ts'
import { setDoc } from '../doc/docs.ts'
import { tryKernelLease } from '../project/project-lock.ts'
import { recordApiClientOver } from '../record/record-api-client.ts'
import type { RecordClientRequest } from '../record/record-api-client-paths.ts'
import { serializeOwnedSettings } from './settings.ts'
import {
  applyMachineSettings,
  printMachineSettingsApplyResults,
  settingsApplyDecision,
} from './settings-machine-apply.ts'
import { productHookDeclarations, withMachineProductHooks } from './settings-machine-hooks.ts'
import { resolveMachineHookRuntime } from './settings-machine-runtime.ts'
import { applySettingsWrite } from './settings-write.ts'

const OWNER = '01990000-0000-7000-8000-000000000001'
const CANON_BODY =
  '---\ndescription: Personal operating rule\nalways: true\n---\n\n# Personal\n\nKeep this rule.\n'
const RECORD_API_URL = 'https://record-api.example.test'
let root = ''
let environment: NodeJS.ProcessEnv
let priorRecordApiUrl: string | undefined

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'settings-machine-apply-'))
  mkdirSync(join(root, '.claude'))
  mkdirSync(join(root, '.codex'))
  environment = {
    HOME: root,
    BOTTEGA_STATE_HOME: join(root, 'state'),
    CODEX_HOME: join(root, '.codex'),
  }
  priorRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
  await setDoc({
    scope: 'settings',
    subject: null,
    owner: OWNER,
    slug: 'settings',
    title: 'settings',
    body: serializeOwnedSettings({
      permissions: { allow: ['Bash(orch *)'] },
      hooks: {},
      autoMode: { allow: ['$defaults', 'Bash(docker compose *)'] },
      envKeys: [],
    }),
    delivery: 'demand',
    reason: 'fixture settings',
  })
  await setDoc({
    scope: 'canon',
    subject: null,
    owner: OWNER,
    slug: 'AGENTS.md',
    title: 'AGENTS.md',
    body: CANON_BODY,
    delivery: 'demand',
    reason: 'fixture canon',
  })
})

afterEach(() => {
  if (priorRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = priorRecordApiUrl
  installRecordApiClient(null)
  rmSync(root, { recursive: true, force: true })
})

function deps() {
  return {
    environment,
    local: db(),
    runsDirectory: join(root, 'runs'),
    workerProcess: () => false,
    owner: async () => OWNER,
    projectPaths: () => [],
    claudeMcpPort: () => ({
      bin: 'claude',
      runner: () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: null,
      }),
      asyncRunner: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: null,
      }),
    }),
    reconcileMcp: () => ({ changed: false }),
    reconcileMcpAsync: async () => ({ changed: false }),
  }
}

function writeCurrentSettings() {
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    `${JSON.stringify(
      {
        ...withMachineProductHooks(
          {
            permissions: { allow: ['Bash(orch *)'] },
            hooks: {},
            autoMode: { allow: ['$defaults', 'Bash(docker compose *)'] },
          },
          undefined,
          join(root, 'state', 'orchestrator', 'orchestrator.db'),
          'on',
          resolveMachineHookRuntime(),
        ).settings,
        env: {},
      },
      null,
      2,
    )}\n`,
  )
}

describe('settings apply', () => {
  test('keeps unowned options in the harness settings file byte-for-byte', async () => {
    writeCurrentSettings()
    const settingsPath = join(root, '.claude', 'settings.json')
    const source = readFileSync(settingsPath, 'utf8').replace(
      '  "permissions":',
      '  "options": {"anything":  1},\n  "permissions":',
    )
    writeFileSync(settingsPath, source)

    await applyMachineSettings({ check: false }, deps())

    expect(readFileSync(settingsPath, 'utf8')).toContain('"options": {"anything":  1}')
  })

  test('check mode bounds hosted reads to identity and document routes', async () => {
    process.env.BOTTEGA_RECORD_API_URL = RECORD_API_URL
    const routes: string[] = []
    const transport: RecordClientRequest = async (path, init = {}) => {
      routes.push(recordRouteClass(path))
      const body =
        path === '/v1/whoami'
          ? {
              user: { id: OWNER, email: 'owner@example.test', emailVerified: true },
              activeSpaceId: 'organization-space',
              personalSpaceId: 'personal-space',
              memberships: [],
            }
          : {
              items: path.includes('scope=settings')
                ? [
                    {
                      owner: OWNER,
                      slug: 'settings',
                      body: serializeOwnedSettings({
                        permissions: { allow: ['Bash(hosted *)'] },
                        hooks: {},
                        envKeys: [],
                      }),
                    },
                  ]
                : [{ owner: OWNER, slug: 'AGENTS.md', body: CANON_BODY }],
              unreadable: [],
              nextCursor: null,
            }
      return (init.schema ? init.schema(body) : body) as never
    }
    installRecordApiClient(recordApiClientOver(transport))

    await applyMachineSettings({ check: true }, deps())

    expect(routes.sort()).toEqual(['record-docs', 'record-docs', 'record-whoami'])
    expect(routes.every((route) => route === 'record-whoami' || route === 'record-docs')).toBe(true)
  })

  test('a hosted install reads personal settings and canon without pulling the record cache', async () => {
    const hosted = createMemoryRecordApiClient()
    await hosted.upsertDoc(
      {
        scope: 'settings',
        subject: null,
        owner: OWNER,
        slug: 'settings',
        title: 'settings',
        body: serializeOwnedSettings({
          permissions: { allow: ['Bash(hosted *)'] },
          hooks: {},
          envKeys: [],
        }),
        delivery: 'demand',
        audiences: ['technical'],
        position: 0,
        reason: 'hosted fixture settings',
        author: OWNER,
      },
      { destinationSpaceId: 'personal-space' },
    )
    await hosted.upsertDoc(
      {
        scope: 'canon',
        subject: null,
        owner: OWNER,
        slug: 'AGENTS.md',
        title: 'AGENTS.md',
        body: CANON_BODY.replace('Keep this rule.', 'Keep this hosted rule.'),
        delivery: 'demand',
        audiences: ['technical'],
        position: 0,
        status: 'current',
        reason: 'hosted fixture canon',
        author: OWNER,
      },
      { destinationSpaceId: 'personal-space' },
    )
    const reads: Array<{ scope?: string; destination?: string }> = []
    installRecordApiClient({
      ...hosted,
      whoami: async () => ({
        user: { id: OWNER },
        activeSpaceId: 'organization-space',
        personalSpaceId: 'personal-space',
        memberships: [],
      }),
      listDocs: async (query, destination) => {
        reads.push({ scope: query.scope, destination: destination?.destinationSpaceId })
        return hosted.listDocs(query, destination)
      },
    })
    process.env.BOTTEGA_RECORD_API_URL = RECORD_API_URL
    writeCurrentSettings()

    const results = await applyMachineSettings({ check: false }, deps())

    expect(reads).toEqual([
      { scope: 'settings', destination: 'personal-space' },
      { scope: 'canon', destination: 'personal-space' },
    ])
    expect(results[0]).toMatchObject({ outcome: 'applied', changed: true })
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toContain('Bash(hosted *)')
    expect(readFileSync(join(root, '.codex', 'AGENTS.md'), 'utf8')).toContain(
      'Keep this hosted rule.',
    )
  })

  test('a hosted install plans product hooks without a personal settings doc', async () => {
    const hosted = createMemoryRecordApiClient()
    installRecordApiClient({
      ...hosted,
      whoami: async () => ({
        user: { id: OWNER },
        activeSpaceId: 'organization-space',
        personalSpaceId: 'personal-space',
        memberships: [],
      }),
    })
    process.env.BOTTEGA_RECORD_API_URL = RECORD_API_URL
    writeFileSync(join(root, '.claude', 'settings.json'), '{}\n')

    expect((await applyMachineSettings({ check: true }, deps()))[0]).toEqual({
      target: `settings ${join(root, '.claude', 'settings.json')}`,
      outcome: 'applied',
      detail: 'would apply; product hooks only; no user settings row',
      changed: true,
    })
  })

  test('a hosted install refuses unreadable personal rows without rendering a partial set', async () => {
    const hosted = createMemoryRecordApiClient()
    await hosted.upsertDoc(
      {
        scope: 'settings',
        subject: null,
        owner: OWNER,
        slug: 'settings',
        title: 'settings',
        body: serializeOwnedSettings({
          permissions: { allow: ['Bash(partial *)'] },
          hooks: {},
          envKeys: [],
        }),
        delivery: 'demand',
        audiences: ['technical'],
        position: 0,
        reason: 'hosted fixture settings',
        author: OWNER,
      },
      { destinationSpaceId: 'personal-space' },
    )
    installRecordApiClient({
      ...hosted,
      whoami: async () => ({
        user: { id: OWNER },
        activeSpaceId: 'organization-space',
        personalSpaceId: 'personal-space',
        memberships: [],
      }),
      listDocs: async (query, destination) => {
        const page = await hosted.listDocs(query, destination)
        return query.scope === 'settings'
          ? {
              ...page,
              unreadable: [{ id: 'settings-row-id', reason: 'invalid settings payload' }],
            }
          : page
      },
    })
    process.env.BOTTEGA_RECORD_API_URL = RECORD_API_URL

    await expect(applyMachineSettings({ check: false }, deps())).rejects.toThrow(
      'settings-row-id: invalid settings payload',
    )
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false)
    expect(existsSync(join(root, '.codex', 'AGENTS.md'))).toBe(false)
  })

  test('a hosted install gives the personal-space remedy for empty user canon', async () => {
    const hosted = createMemoryRecordApiClient()
    await hosted.upsertDoc(
      {
        scope: 'settings',
        subject: null,
        owner: OWNER,
        slug: 'settings',
        title: 'settings',
        body: serializeOwnedSettings({ permissions: {}, hooks: {}, envKeys: [] }),
        delivery: 'demand',
        audiences: ['technical'],
        position: 0,
        reason: 'hosted fixture settings',
        author: OWNER,
      },
      { destinationSpaceId: 'personal-space' },
    )
    installRecordApiClient({
      ...hosted,
      whoami: async () => ({
        user: { id: OWNER },
        activeSpaceId: 'organization-space',
        personalSpaceId: 'personal-space',
        memberships: [],
      }),
    })
    process.env.BOTTEGA_RECORD_API_URL = RECORD_API_URL

    const refusals = (await applyMachineSettings({ check: true }, deps())).filter(
      (result) => result.condition === 'empty-user-canon-store',
    )

    expect(refusals).toHaveLength(2)
    expect(refusals.every((result) => result.detail?.includes('hosted personal space'))).toBe(true)
    expect(
      refusals.every((result) =>
        result.detail?.includes(`${PLATFORM_SLUG} doc set --scope canon --user`),
      ),
    ).toBe(true)
    expect(refusals.every((result) => !result.detail?.includes('record push'))).toBe(true)
  })

  test('signed in without settings applies product hooks and still refuses empty canon', async () => {
    db().query("DELETE FROM doc WHERE scope='settings' AND owner=?").run(OWNER)
    db().query("DELETE FROM doc WHERE scope='canon' AND owner=?").run(OWNER)
    writeFileSync(join(root, '.claude', 'settings.json'), '{}\n')

    const results = await applyMachineSettings({ check: false }, deps())

    expect(results[0]).toMatchObject({
      outcome: 'applied',
      detail: expect.stringContaining('product hooks only; no user settings row'),
      changed: true,
    })
    expect(results.filter((result) => result.condition === 'empty-user-canon-store')).toHaveLength(
      2,
    )
    expect(settingsApplyDecision(true, results).action).toBe('refuse')
    const rendered = readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
    for (const hook of productHookDeclarations(undefined)) expect(rendered).toContain(hook.script)
    expect(rendered).not.toContain('block-agent.py')
  })

  test('without a settings row creates an absent Claude home and settings file', async () => {
    db().query("DELETE FROM doc WHERE scope='settings' AND owner=?").run(OWNER)
    const claudeHome = join(root, '.claude')
    const settingsPath = join(claudeHome, 'settings.json')
    rmSync(claudeHome, { recursive: true })

    expect((await applyMachineSettings({ check: true }, deps()))[0]).toMatchObject({
      outcome: 'applied',
      detail: 'would apply; product hooks only; no user settings row',
      changed: true,
    })
    expect(existsSync(claudeHome)).toBe(false)
    expect(existsSync(settingsPath)).toBe(false)

    const results = await applyMachineSettings({ check: false }, deps())

    expect(results[0]).toMatchObject({
      outcome: 'applied',
      detail: 'created new file; product hooks only; no user settings row',
      changed: true,
    })
    expect(existsSync(claudeHome)).toBe(true)
    expect(statSync(claudeHome).mode & 0o777).toBe(0o700)
    expect(existsSync(settingsPath)).toBe(true)
    const rendered = readFileSync(settingsPath, 'utf8')
    for (const hook of productHookDeclarations(undefined)) expect(rendered).toContain(hook.script)
    expect(rendered).not.toContain('block-agent.py')
  })

  test('with a settings row creates an absent settings file with owned values', async () => {
    const settingsPath = join(root, '.claude', 'settings.json')

    const results = await applyMachineSettings({ check: false }, deps())

    expect(results[0]).toMatchObject({
      outcome: 'applied',
      detail: 'created new file',
      changed: true,
    })
    expect(existsSync(settingsPath)).toBe(true)
    const rendered = readFileSync(settingsPath, 'utf8')
    expect(JSON.parse(rendered).permissions).toEqual({ allow: ['Bash(orch *)'] })
    for (const hook of productHookDeclarations(undefined)) expect(rendered).toContain(hook.script)
    expect(rendered).not.toContain('block-agent.py')
  })

  test('an off choice removes both rendered block-agent hooks and reports it once', async () => {
    const settingsPath = join(root, '.claude', 'settings.json')
    const previouslyOn = withMachineProductHooks(
      { permissions: {}, hooks: {}, options: { subagentHooks: 'on' } },
      { subagentHooks: 'on' },
      resolveOrchestratorDatabase(environment),
      'on',
      resolveMachineHookRuntime(),
    ).settings
    writeFileSync(settingsPath, serializeOwnedSettings(previouslyOn))

    const results = await applyMachineSettings({ check: false }, deps())
    const logs: string[] = []
    printMachineSettingsApplyResults(results, (...parts) => logs.push(parts.join(' ')))

    expect(readFileSync(settingsPath, 'utf8')).not.toContain('block-agent.py')
    expect(logs.filter((line) => line.includes('block-agent hooks removed'))).toHaveLength(1)
  })

  test('options with future members and future top-level keys do not change applied Claude settings', async () => {
    const row = getDoc('settings', null, 'settings', OWNER)!
    const body = JSON.stringify({
      ...JSON.parse(row.body),
      options: { subagentHooks: 'on', futureOption: 1 },
      futureKey: true,
    })
    db().query('UPDATE doc SET body=? WHERE record_id=?').run(body, row.record_id)

    const checked = await applyMachineSettings({ check: true }, deps())
    expect(checked[0]).toMatchObject({ outcome: 'applied', changed: true })

    const results = await applyMachineSettings({ check: false }, deps())

    expect(results[0]).toMatchObject({ outcome: 'applied', changed: true })
    const rendered = readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
    expect(rendered).not.toContain('subagentHooks')
    expect(rendered).not.toContain('futureOption')
    expect(rendered).not.toContain('futureKey')
    expect(rendered).toContain('block-agent.py')
  })

  test('without a settings row preserves file-owned settings while adding product hooks', async () => {
    db().query("DELETE FROM doc WHERE scope='settings' AND owner=?").run(OWNER)
    const settingsPath = join(root, '.claude', 'settings.json')
    const personalHook = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: '/usr/local/bin/personal-hook' }],
    }
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          permissions: { allow: ['Bash(git status)'] },
          hooks: { PreToolUse: [personalHook] },
          env: { PERSONAL_TOKEN: 'fixture-value' },
        },
        null,
        2,
      )}\n`,
    )

    const results = await applyMachineSettings({ check: false }, deps())

    expect(results[0]).toMatchObject({
      outcome: 'applied',
      detail: expect.stringContaining('product hooks only; no user settings row'),
    })
    const rendered = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(rendered.permissions).toEqual({ allow: ['Bash(git status)'] })
    expect(rendered.hooks.PreToolUse).toContainEqual(personalHook)
    expect(rendered.env).toEqual({ PERSONAL_TOKEN: 'fixture-value' })
    for (const hook of productHookDeclarations(undefined)) {
      expect(readFileSync(settingsPath, 'utf8')).toContain(hook.script)
    }
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('block-agent.py')
  })

  test('pre-sign-in missing user rows still wait for sign-in after product hooks apply', async () => {
    db().query("DELETE FROM doc WHERE scope IN ('settings', 'canon') AND owner=?").run(OWNER)
    writeFileSync(join(root, '.claude', 'settings.json'), '{}\n')

    const results = await applyMachineSettings({ check: false }, deps())

    expect(results[0]).toMatchObject({ outcome: 'applied', changed: true })
    expect(settingsApplyDecision(false, results).action).toBe('wait-for-sign-in')
  })

  test('--check reports current and changed targets without writing', async () => {
    writeCurrentSettings()
    const before = readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
    const results = await applyMachineSettings({ check: true }, deps())
    expect(results[0]).toMatchObject({ outcome: 'current', changed: false })
    expect(results.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: expect.stringContaining('canon claude'),
          detail: 'would apply',
        }),
        expect.objectContaining({
          target: expect.stringContaining('canon codex'),
          detail: 'would apply',
        }),
      ]),
    )
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toBe(before)
    expect(existsSync(join(root, '.claude', 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(root, '.codex', 'AGENTS.md'))).toBe(false)
  })

  test('applies changed settings with a backup and reports new canon files', async () => {
    writeFileSync(join(root, '.claude', 'settings.json'), '{"permissions":{},"hooks":{}}\n')
    const results = await applyMachineSettings({ check: false }, deps())
    expect(results[0]).toMatchObject({
      outcome: 'applied',
      detail: expect.stringContaining('backup '),
    })
    expect(results.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: expect.stringContaining('canon claude'),
          detail: 'created new file',
        }),
        expect.objectContaining({
          target: expect.stringContaining('canon codex'),
          detail: 'created new file',
        }),
      ]),
    )
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toContain('Bash(orch *)')
    expect(
      JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).autoMode,
    ).toEqual({ allow: ['$defaults', 'Bash(docker compose *)'] })
    expect(readFileSync(join(root, '.codex', 'AGENTS.md'), 'utf8')).toContain('Generated by')
  })

  test('preserves unowned auto-mode bytes through session-start overlay and hooks', async () => {
    const row = getDoc('settings', null, 'settings', OWNER)!
    await setDoc({
      scope: 'settings',
      subject: null,
      owner: OWNER,
      slug: 'settings',
      title: 'settings',
      body: serializeOwnedSettings({
        permissions: { allow: ['Bash(orch *)'] },
        hooks: {},
        envKeys: [],
      }),
      delivery: 'demand',
      reason: 'make auto-mode unowned',
      expectedRevision: row.revision!,
    })
    const settingsPath = join(root, '.claude', 'settings.json')
    const withoutAutoMode = `${JSON.stringify(
      {
        ...withMachineProductHooks(
          { permissions: { allow: ['Bash(orch *)'] }, hooks: {} },
          undefined,
          resolveOrchestratorDatabase(environment),
          'on',
          resolveMachineHookRuntime(),
        ).settings,
        env: {},
      },
      null,
      2,
    )}\n`
    const withLocalAutoMode = withoutAutoMode.replace(
      '  "env": {}',
      '  "autoMode": { "allow":["$defaults",  "local"] },\n  "env": {}',
    )

    writeFileSync(settingsPath, withLocalAutoMode)
    const preserved = await applyMachineSettings({ check: false }, deps())
    expect(preserved[0]).toMatchObject({ outcome: 'current', changed: false })
    expect(readFileSync(settingsPath, 'utf8')).toBe(withLocalAutoMode)

    writeFileSync(settingsPath, withoutAutoMode)
    const omitted = await applyMachineSettings({ check: false }, deps())
    expect(omitted[0]).toMatchObject({ outcome: 'current', changed: false })
    expect(readFileSync(settingsPath, 'utf8')).toBe(withoutAutoMode)
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('autoMode')
  })

  test('omits non-current user canon from every harness home', async () => {
    await setDoc({
      scope: 'canon',
      subject: null,
      owner: OWNER,
      slug: '.agents/rules/draft.md',
      title: 'Draft rule',
      body: '---\ndescription: Draft\nalways: true\n---\n\nDraft only.\n',
      delivery: 'demand',
      status: 'draft',
      reason: 'fixture draft canon',
    })
    writeCurrentSettings()

    await applyMachineSettings({ check: false }, deps())

    expect(existsSync(join(root, '.claude', 'rules', 'draft.md'))).toBe(false)
    expect(existsSync(join(root, '.codex', 'rules', 'draft.md'))).toBe(false)
  })

  test('renders hosted settings merged with the machine overlay and reports unmatched drops', async () => {
    const config = join(root, '.config', PLATFORM_SLUG)
    mkdirSync(config, { recursive: true })
    writeFileSync(
      join(config, 'machine.toml'),
      '[machine]\nglobal_use = "off"\n' +
        '[permissions]\nallow = ["Bash(git status)"]\n' +
        '[permissions.drop]\nallow = ["Bash(orch *)", "Bash(missing)"]\n',
    )
    writeCurrentSettings()
    const results = await applyMachineSettings({ check: false }, deps())
    expect(results[0]).toMatchObject({
      outcome: 'applied',
      detail: expect.stringContaining('unmatched drop(s): allow Bash(missing)'),
    })
    const applied = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'))
    expect(applied.permissions).toEqual({ allow: ['Bash(git status)'] })
    expect(applied.autoMode).toEqual({ allow: ['$defaults', 'Bash(docker compose *)'] })
    expect(applied.env).toEqual({})
    expect(existsSync(join(root, '.claude', 'settings.local.json'))).toBe(false)
    const productHookCommands = Object.values(
      applied.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>,
    )
      .flat()
      .flatMap((group) => group.hooks)
      .map((hook) => hook.command)
    expect(productHookCommands.length).toBeGreaterThan(0)
    for (const command of productHookCommands) {
      expect(command).toContain('BOTTEGA_GLOBAL_USE=off')
    }
  })

  test('a canon planning refusal preserves the atomic batch and reports every home', async () => {
    writeCurrentSettings()
    writeFileSync(join(root, '.claude', 'CLAUDE.md'), 'unique local instructions\n')
    const results = await applyMachineSettings({ check: false }, deps())
    expect(results[0]).toMatchObject({ outcome: 'current' })
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: expect.stringContaining('canon claude'),
          outcome: 'refused',
          detail: expect.stringContaining('refusing to overwrite unmarked'),
        }),
        expect.objectContaining({
          target: expect.stringContaining('canon codex'),
          outcome: 'refused',
          detail: 'not written: canon batch refused',
        }),
      ]),
    )
    expect(existsSync(join(root, '.codex', 'AGENTS.md'))).toBe(false)
  })

  test('an empty user canon store refuses managed-file deletes in apply and check modes', async () => {
    writeCurrentSettings()
    db().query("DELETE FROM doc WHERE scope='canon' AND owner=?").run(OWNER)
    const claudePath = join(root, '.claude', 'CLAUDE.md')
    const codexPath = join(root, '.codex', 'AGENTS.md')
    writeFileSync(claudePath, `${USER_CANON_MANAGED_MARKER}other store`)
    writeFileSync(codexPath, `${USER_CANON_MANAGED_MARKER}other store`)
    let applies = 0

    for (const check of [false, true]) {
      const results = await applyMachineSettings(
        { check },
        {
          ...deps(),
          applyCanon: () => {
            applies++
            return { backups: [], cleanupFailures: [] }
          },
        },
      )
      expect(results.slice(1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: expect.stringContaining('canon claude'),
            outcome: 'refused',
            detail: expect.stringMatching(
              new RegExp(
                `no user canon rows have arrived.*${PLATFORM_SLUG} record push.*${PLATFORM_SLUG} doc set --scope canon --user`,
              ),
            ),
            changed: false,
          }),
          expect.objectContaining({
            target: expect.stringContaining('canon codex'),
            outcome: 'refused',
            changed: false,
          }),
        ]),
      )
      expect(readFileSync(claudePath, 'utf8')).toBe(`${USER_CANON_MANAGED_MARKER}other store`)
      expect(readFileSync(codexPath, 'utf8')).toBe(`${USER_CANON_MANAGED_MARKER}other store`)
    }
    expect(applies).toBe(0)
  })

  test('a settings changed-after-planning refusal does not stop canon', async () => {
    writeFileSync(join(root, '.claude', 'settings.json'), '{"permissions":{},"hooks":{}}\n')
    const path = join(root, '.claude', 'settings.json')
    const results = await applyMachineSettings(
      { check: false },
      {
        ...deps(),
        applySettings: (plan, state) => {
          writeFileSync(path, '{"permissions":{"ask":[]},"hooks":{}}\n')
          return applySettingsWrite(plan, state)
        },
      },
    )
    expect(results[0]).toMatchObject({
      outcome: 'refused',
      detail: expect.stringContaining('changed after planning'),
    })
    expect(results.slice(1, -1).every((result) => result.outcome === 'applied')).toBe(true)
  })

  test('refuses from an orchestrator worker before reading documents or opening writable state', async () => {
    await expect(
      applyMachineSettings(
        { check: true },
        {
          workerProcess: () => true,
        },
      ),
    ).rejects.toThrow('refusing settings apply from an orchestrator worker run')
  })

  test('a secondary checkout refuses real harness homes before reading documents', async () => {
    await expect(
      applyMachineSettings(
        { check: false },
        {
          environment: {
            HOME: '/operator',
            CODEX_HOME: '/operator/.codex',
          },
          local: db(),
          workerProcess: () => false,
          runningFromRegisteredMainCheckout: false,
          registeredMainCheckout: root,
          binaryRepositoryRoot: root,
        },
      ),
    ).rejects.toThrow(`cleared by: run \`${root}/bin/${PLATFORM_SLUG} machine settings apply\``)
  })

  test('a mixed temporary and real harness environment is refused before reading documents', async () => {
    await expect(
      applyMachineSettings(
        { check: false },
        {
          environment: {
            HOME: root,
            CODEX_HOME: '/operator/.codex',
            GROK_HOME: join(root, '.grok'),
          },
          local: db(),
          workerProcess: () => false,
          runningFromRegisteredMainCheckout: false,
          registeredMainCheckout: '/projects/main',
        },
      ),
    ).rejects.toThrow("real harness homes may only be written from this machine's installed copy")
  })

  test('skips successfully when another settings apply holds the per-user lock', async () => {
    const stateDirectory = join(root, 'state', 'orchestrator')
    mkdirSync(stateDirectory, { recursive: true })
    const lease = tryKernelLease(join(stateDirectory, 'settings-apply.lock'), true)
    expect(lease).not.toBeNull()
    try {
      expect(await applyMachineSettings({ check: false }, deps())).toEqual([
        { target: 'settings apply', outcome: 'skipped', changed: false },
      ])
    } finally {
      lease!.release()
    }
  })

  test('presentation emits target lines and one deletion notice per superseded profile handler', () => {
    const lines: string[] = []
    printMachineSettingsApplyResults(
      [
        {
          target: 'settings one',
          outcome: 'current',
          changed: false,
          superseded: [{ event: 'PreToolUse', matcher: 'Bash', script: 'git-guard.py' }],
        },
        { target: 'canon two', outcome: 'refused', detail: 'first\nsecond', changed: false },
        {
          target: 'project /projects/missing',
          outcome: 'skipped',
          detail: 'missing path',
          changed: false,
        },
        { target: 'settings apply', outcome: 'skipped', changed: false },
      ],
      (...values) => lines.push(values.join(' ')),
    )
    expect(lines).toEqual([
      'settings one: already current',
      'profile hook PreToolUse Bash git-guard.py is superseded by the product hook and can be deleted from the profile',
      'canon two: refused; first; second',
      'project /projects/missing: skipped; missing path',
      'settings apply already running; skipped',
    ])
  })
})
