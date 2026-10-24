import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import { INSTALL_HOME_ENV } from '../../shared/install-root.ts'
import { OperatorWaitingItemSchema, OrchBlockersSchema } from '../../shared/orch-contract.ts'
import {
  answerWaitingArgv,
  boardList,
  boardPostArgv,
  configArgv,
  configDeleteArgv,
  contextArgv,
  contextGet,
  decodeRunsJson,
  fileRulingArgv,
  MachineAutonomyEntrySchema,
  MachinePermissionOverlaySchema,
  MachinePermissionResultSchema,
  machineConfigArgv,
  machinePermissionArgv,
  machinePermissionListArgv,
  projectArgv,
  settingsCheck,
  settingsCheckArgv,
  settingsPermissionArgv,
  startDashboardCapability,
  stopDashboardCapability,
} from './orch.ts'

test('board post bridge carries its resolved purpose', () => {
  const argv = boardPostArgv({
    audience: 'operator',
    title: 'Required notice',
    body: 'Body',
    purpose: 'request',
    ackRequired: true,
  })
  const purpose = argv.indexOf('--purpose')
  expect(purpose).toBeGreaterThan(-1)
  expect(argv[purpose + 1]).toBe('request')
})

test('machine bridge schemas parse the CLI output shapes', () => {
  expect(
    MachinePermissionResultSchema.parse({
      changed: true,
      counts: { allow: 1, ask: 2, deny: 3 },
      message: 'updated machine permissions',
    }),
  ).toEqual({
    changed: true,
    counts: { allow: 1, ask: 2, deny: 3 },
    message: 'updated machine permissions',
  })
  expect(
    MachinePermissionOverlaySchema.parse({
      additions: { allow: ['Bash(orch *)'], ask: [], deny: [] },
      drop: { allow: [], ask: ['Bash(rm *)'], deny: [] },
    }),
  ).toEqual({
    additions: { allow: ['Bash(orch *)'], ask: [], deny: [] },
    drop: { allow: [], ask: ['Bash(rm *)'], deny: [] },
  })
  expect(
    MachineAutonomyEntrySchema.parse({
      key: 'autonomy.stage.review',
      value: 'auto',
      scope: 'local user',
    }),
  ).toEqual({
    key: 'autonomy.stage.review',
    value: 'auto',
    scope: 'local user',
  })
})

test('managed context wrappers build exact argv', () => {
  expect(contextArgv('/work/project')).toEqual([
    'agent',
    'context',
    '--cwd',
    '/work/project',
    '--json',
  ])
  expect(configArgv('get', 'autonomy.stage.review')).toEqual([
    'machine',
    'config',
    'get',
    'autonomy.stage.review',
    '--json',
  ])
  expect(configArgv('list')).toEqual(['machine', 'config', 'list', '--json'])
  expect(configArgv('set', 'autonomy.stage.review', 'auto')).toEqual([
    'machine',
    'config',
    'set',
    'autonomy.stage.review',
    'auto',
    '--json',
  ])
  expect(configArgv('set', 'autonomy.preset', 'manual', 4)).toEqual([
    'machine',
    'config',
    'set',
    'autonomy.preset',
    'manual',
    '--expect',
    '4',
    '--json',
  ])
  expect(configDeleteArgv('autonomy.stage.review')).toEqual([
    'machine',
    'config',
    'delete',
    'autonomy.stage.review',
  ])
  expect(configDeleteArgv('autonomy.stage.review', 3)).toEqual([
    'machine',
    'config',
    'delete',
    'autonomy.stage.review',
    '--expect',
    '3',
  ])
  expect(machineConfigArgv('list')).toEqual(['machine', 'config', 'list', '--machine', '--json'])
  expect(machineConfigArgv('set', 'autonomy.stage.review', 'auto')).toEqual([
    'machine',
    'config',
    'set',
    'autonomy.stage.review',
    'auto',
    '--machine',
    '--json',
  ])
  expect(machineConfigArgv('delete', 'autonomy.ship-to')).toEqual([
    'machine',
    'config',
    'delete',
    'autonomy.ship-to',
    '--machine',
  ])
  expect(settingsCheckArgv({ user: true })).toEqual([
    'machine',
    'settings',
    'render',
    '--check',
    '--user',
    '--json',
  ])
  expect(settingsCheckArgv({ project: PLATFORM_NAME })).toEqual([
    'machine',
    'settings',
    'render',
    '--check',
    '--project',
    PLATFORM_NAME,
    '--json',
  ])
  expect(
    settingsPermissionArgv({
      target: { project: PLATFORM_NAME },
      operation: 'add',
      list: 'allow',
      rule: 'Bash(orch *)',
      expectedRevision: 'revision-1',
      reason: 'needed',
    }),
  ).toEqual([
    'machine',
    'settings',
    'permission',
    'add',
    '--project',
    PLATFORM_NAME,
    '--list',
    'allow',
    '--rule',
    'Bash(orch *)',
    '--expect',
    'revision-1',
    '--reason',
    'needed',
    '--json',
  ])
  expect(machinePermissionListArgv()).toEqual([
    'machine',
    'settings',
    'permission',
    'list',
    '--machine',
    '--json',
  ])
  expect(machinePermissionArgv({ operation: 'add', list: 'allow', rule: 'Bash(orch *)' })).toEqual([
    'machine',
    'settings',
    'permission',
    'add',
    '--machine',
    '--list',
    'allow',
    '--rule',
    'Bash(orch *)',
    '--json',
  ])
  expect(machinePermissionArgv({ operation: 'drop', list: 'ask', rule: 'Bash(rm *)' })).toEqual([
    'machine',
    'settings',
    'permission',
    'drop',
    '--list',
    'ask',
    '--rule',
    'Bash(rm *)',
    '--json',
  ])
})

test('context accepts a null landing branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-context-null-landing-'))
  const executable = join(root, 'orch-context')
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\\n' '{"registered":true,"project":"fixture","rulings":{"value":"agent","scope":"built-in"},"shipTo":{"value":"trunk","scope":"built-in","landing":null,"production":null},"stages":[],"text":"ship to: trunk (no landing branch declared) (built-in)"}'
`,
  )
  chmodSync(executable, 0o755)
  const prior = process.env.BOTTEGA_ORCH
  try {
    process.env.BOTTEGA_ORCH = executable
    const result = await contextGet('/fixture')
    expect(result.registered && result.shipTo.landing).toBeNull()
  } finally {
    if (prior === undefined) delete process.env.BOTTEGA_ORCH
    else process.env.BOTTEGA_ORCH = prior
    rmSync(root, { recursive: true, force: true })
  }
})

test('settings check preserves an exit-one refusal with empty stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-settings-refusal-'))
  const executable = join(root, 'orch-refusal')
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' 'no signed-in record session; run ${PLATFORM_SLUG} record login' >&2\nexit 1\n`,
  )
  chmodSync(executable, 0o755)
  const prior = process.env.BOTTEGA_ORCH
  try {
    process.env.BOTTEGA_ORCH = executable
    await expect(settingsCheck({ user: true })).rejects.toThrow(
      `no signed-in record session; run ${PLATFORM_SLUG} record login`,
    )
  } finally {
    if (prior === undefined) delete process.env.BOTTEGA_ORCH
    else process.env.BOTTEGA_ORCH = prior
    rmSync(root, { recursive: true, force: true })
  }
})

test('board calls remove worker and harness identity markers from the orchestrator child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-board-operator-env-'))
  const executable = join(root, 'orch-board-env')
  writeFileSync(
    executable,
    `#!/bin/sh
if env | grep -Eq '^(BOTTEGA_RUN_ID|BOTTEGA_DEPTH|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID)='; then
  printf '%s\n' 'board child inherited a session or run marker' >&2
  exit 1
fi
printf '%s\n' '{"messages":[],"warning":null}'
`,
  )
  chmodSync(executable, 0o755)
  const prior = {
    BOTTEGA_ORCH: process.env.BOTTEGA_ORCH,
    BOTTEGA_RUN_ID: process.env.BOTTEGA_RUN_ID,
    BOTTEGA_DEPTH: process.env.BOTTEGA_DEPTH,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
  }
  try {
    process.env.BOTTEGA_ORCH = executable
    process.env.BOTTEGA_RUN_ID = '42'
    process.env.BOTTEGA_DEPTH = '1'
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    process.env.CODEX_THREAD_ID = 'codex-thread'
    await expect(boardList({})).resolves.toEqual({ messages: [], warning: null })
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('operator file-ruling argv runs the verb through the orchestrator seam with json', () => {
  expect(fileRulingArgv({ questionId: 7, as: 'doc' })).toEqual([
    'question',
    'ruling',
    'file',
    '7',
    '--as',
    'doc',
    '--from-operator',
    '--channel',
    'ui',
    '--json',
  ])
  expect(
    fileRulingArgv({
      questionId: 7,
      as: 'canon',
      scope: 'project',
      subject: PLATFORM_SLUG,
      title: 'Which shape?',
    }),
  ).toEqual([
    'question',
    'ruling',
    'file',
    '7',
    '--as',
    'canon',
    '--scope',
    'project',
    '--subject',
    PLATFORM_SLUG,
    '--title',
    'Which shape?',
    '--from-operator',
    '--channel',
    'ui',
    '--json',
  ])
})

test('operator answer argv preserves the ruling and records the UI operator channel', () => {
  expect(
    answerWaitingArgv('00000000-0000-4000-8000-000000000042', [
      { questionId: 7, ruling: 'Use the existing shape' },
      { questionId: 8, ruling: 'Keep both' },
    ]),
  ).toEqual([
    'question',
    'answer',
    '00000000-0000-4000-8000-000000000042',
    '--q7',
    'Use the existing shape',
    '--q8',
    'Keep both',
    '--from-operator',
    '--channel',
    'ui',
    '--json',
  ])
})

test(`the ${PLATFORM_SLUG} run waiting client contract accepts a no-project item`, () => {
  expect(
    OperatorWaitingItemSchema.parse({
      kind: 'question',
      id: 7,
      workflow_cursor_record_id: null,
      question_record_id: '00000000-0000-4000-8000-000000000007',
      run_number: 42,
      run_record_id: '00000000-0000-4000-8000-000000000042',
      project: null,
      task_key: null,
      session_id: null,
      question: 'Which?',
      options: [],
      recommendation: null,
      why: null,
      waiting_since: '2026-09-25',
      episode: '2026-09-25',
      answer_command: `${PLATFORM_SLUG} question answer 42 --q7 "<ruling>"`,
    }),
  ).toMatchObject({ project: null })
})

const runFixture = {
  number: 42,
  record_id: '00000000-0000-4000-8000-000000000042',
  started_at: '2026-09-06T12:00:00.000Z',
  agent: 'codex',
  job: 'implement',
  repo: 'sample',
  cwd: '/tmp/sample',
  session_id: null,
  latency_ms: 100,
  vendor_tokens: 12,
  vendor_cost_usd: null,
  prompt_head: 'Build it',
  prompt_path: null,
  branch: 'DEV-340-example',
  probe: 0,
  status: 'ok',
  delivery: 'full',
  quality: 'right',
  retry_record_id: null,
  turns: [
    {
      number: 42,
      record_id: '00000000-0000-4000-8000-000000000042',
      started_at: '2026-09-06T12:00:00.000Z',
      latency_ms: 100,
      vendor_tokens: 12,
      vendor_cost_usd: null,
      status: 'ok',
      turn: 1,
    },
  ],
  questions: [],
  launch_key: 'DEV-340',
}

const runLine = (value: unknown, version: 1 | 2 = 2) =>
  JSON.stringify(version === 1 ? value : { schema_version: 2, kind: 'run', data: value })

test('v1 and v2 run lines decode to the same run', () => {
  const v1 = runLine(runFixture, 1)
  const v2 = runLine(runFixture, 2)
  expect(decodeRunsJson(v1)).toEqual(decodeRunsJson(v2))
  expect(decodeRunsJson(v2)).toEqual([runFixture])
})

test('run contract accepts only the UUID retry link', () => {
  expect(() =>
    decodeRunsJson(runLine({ ...runFixture, retry_of: 41, retry_record_id: undefined })),
  ).toThrow()
  expect(() => decodeRunsJson(runLine({ ...runFixture, retry_record_id: 'not-a-uuid' }))).toThrow()
  expect(
    decodeRunsJson(
      runLine({
        ...runFixture,
        retry_record_id: '00000000-0000-4000-8000-000000000041',
      }),
    )[0],
  ).toMatchObject({ retry_record_id: '00000000-0000-4000-8000-000000000041' })
})

test('orch-owned run and blocker fields remain optional to hub', () => {
  const runWithoutTurn = {
    ...runFixture,
    turns: runFixture.turns.map(({ turn: _turn, ...turn }) => turn),
  }
  expect(decodeRunsJson(runLine(runWithoutTurn, 2))).toEqual([runWithoutTurn])
  expect(
    OrchBlockersSchema.parse({
      blockers: [
        {
          kind: null,
          source: 'declared',
          runs: 1,
          projects: 1,
          agents: ['codex'],
          example: null,
        },
      ],
    }),
  ).toEqual({
    blockers: [
      {
        kind: null,
        source: 'declared',
        runs: 1,
        projects: 1,
        agents: ['codex'],
        example: null,
      },
    ],
  })
})

test('malformed NDJSON reports its physical line number', () => {
  expect(() => decodeRunsJson(`\n${runLine(runFixture, 2)}\nnot-json`)).toThrow('line 3')
})

test('an unknown envelope kind reports its physical line number', () => {
  const other = JSON.stringify({ schema_version: 2, kind: 'other', data: runFixture })
  expect(() => decodeRunsJson(`${runLine(runFixture, 2)}\n\n${other}`)).toThrow('line 3')
})

test('only the orchestrator client names a top-level ORCH binding', () => {
  const root = fileURLToPath(new URL('./', import.meta.url))
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      entry.name !== 'orch.ts' &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.fixture.ts'),
  )
  const violations = files.flatMap((entry) => {
    const path = join(entry.parentPath, entry.name)
    const source = readFileSync(path, 'utf8')
    return /\b(?:const|let|var)\s+ORCH\b/.test(source) ? [path.slice(root.length)] : []
  })
  expect(violations).toEqual([])
})

test('orchestrator resolution accepts only executable files from override, checkout, and PATH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-orch-resolution-'))
  const bundledRoot = join(root, 'checkout')
  const outputDir = join(bundledRoot, 'hub', 'src')
  mkdirSync(outputDir, { recursive: true })
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL('orch.ts', import.meta.url))],
    outdir: outputDir,
    target: 'bun',
    format: 'esm',
  })
  expect(built.success).toBe(true)
  const checkoutCandidate = join(bundledRoot, 'bin', PLATFORM_SLUG)
  mkdirSync(checkoutCandidate, { recursive: true })
  const first = join(root, 'first-bin')
  const second = join(root, 'second-bin')
  mkdirSync(join(first, PLATFORM_SLUG), { recursive: true })
  mkdirSync(second)
  const found = join(second, PLATFORM_SLUG)
  writeFileSync(found, '#!/bin/sh\nexit 0\n')
  chmodSync(found, 0o755)
  const override = join(root, 'override-orch')
  mkdirSync(override)
  const priorOrch = process.env.BOTTEGA_ORCH
  const priorPath = process.env.PATH
  const priorHome = process.env[INSTALL_HOME_ENV]
  try {
    process.env[INSTALL_HOME_ENV] = bundledRoot
    process.env.BOTTEGA_ORCH = override
    process.env.PATH = `${first}:${second}`
    const bundled = await import(`${built.outputs[0]!.path}?test=${Date.now()}`)
    expect(bundled.resolveOrchExecutable()).toBe(found)

    process.env.PATH = first
    expect(() => bundled.resolveOrchExecutable()).toThrow(
      `BOTTEGA_ORCH override ${override}; checkout executable ${checkoutCandidate}; PATH lookup found nothing`,
    )
    delete process.env.BOTTEGA_ORCH
    expect(() => bundled.resolveOrchExecutable()).toThrow('BOTTEGA_ORCH override unset')
    expect(() => bundled.resolveOrchExecutable()).not.toThrow(/at call time|restart|moved|renamed/)
  } finally {
    if (priorOrch === undefined) delete process.env.BOTTEGA_ORCH
    else process.env.BOTTEGA_ORCH = priorOrch
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    if (priorHome === undefined) delete process.env[INSTALL_HOME_ENV]
    else process.env[INSTALL_HOME_ENV] = priorHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('dashboard scoring capability is private and bound to this dashboard process', () => {
  const path = startDashboardCapability()
  try {
    const file = statSync(path)
    const dir = statSync(dirname(path))
    expect(file.mode & 0o777).toBe(0o600)
    expect(dir.mode & 0o777).toBe(0o700)
    const body = JSON.parse(readFileSync(path, 'utf8')) as { token: string; pid: number }
    expect(body.pid).toBe(process.pid)
    expect(body.token.length).toBeGreaterThan(20)
  } finally {
    stopDashboardCapability()
  }
})

describe('projectArgv', () => {
  test('builds add argv with each canon state and no shell quoting', () => {
    expect(
      projectArgv('add', 'named project', {
        path: '/tmp/a path',
        stack: 'bun react',
        canon: true,
      }),
    ).toEqual([
      'project',
      'add',
      '/tmp/a path',
      '--name',
      'named project',
      '--stack',
      'bun react',
      '--canon',
      '--json',
    ])
    expect(projectArgv('add', undefined, { path: '/tmp/project', canon: false })).toEqual([
      'project',
      'add',
      '/tmp/project',
      '--no-canon',
      '--json',
    ])
    expect(projectArgv('add', undefined, { path: '/tmp/project' })).toEqual([
      'project',
      'add',
      '/tmp/project',
      '--json',
    ])
  })

  test('builds set argv with optional settings and passes null through JSON', () => {
    expect(
      projectArgv('set', 'alpha', {
        path: '/tmp/a path',
        stack: 'ts',
        canon: false,
        settings: { tracker: null, nested: { value: null } },
      }),
    ).toEqual([
      'project',
      'set',
      'alpha',
      '--path',
      '/tmp/a path',
      '--stack',
      'ts',
      '--no-canon',
      '--settings',
      '{"tracker":null,"nested":{"value":null}}',
      '--json',
    ])
    expect(projectArgv('set', 'alpha', { canon: true })).toEqual([
      'project',
      'set',
      'alpha',
      '--canon',
      '--json',
    ])
    expect(projectArgv('set', 'alpha', {})).toEqual(['project', 'set', 'alpha', '--json'])
  })

  test('builds remove argv as separate array elements', () => {
    const argv = projectArgv('remove', 'a project')
    expect(argv).toEqual(['project', 'remove', 'a project'])
    expect(Array.isArray(argv)).toBe(true)
    expect(argv).not.toContain("'a project'")
  })
})
