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
  configArgv,
  configDeleteArgv,
  contextArgv,
  contextGet,
  decodeRunsJson,
  docArgv,
  fileRulingArgv,
  projectArgv,
  settingsCheck,
  settingsCheckArgv,
  settingsPermissionArgv,
  startDashboardCapability,
  stopDashboardCapability,
} from './orch.ts'

test('managed context wrappers build exact argv', () => {
  expect(contextArgv('/work/project')).toEqual(['context', '--cwd', '/work/project', '--json'])
  expect(configArgv('get', 'autonomy.stage.review')).toEqual([
    'config',
    'get',
    'autonomy.stage.review',
    '--json',
  ])
  expect(configArgv('list')).toEqual(['config', 'list', '--json'])
  expect(configArgv('set', 'autonomy.stage.review', 'auto')).toEqual([
    'config',
    'set',
    'autonomy.stage.review',
    'auto',
    '--json',
  ])
  expect(configDeleteArgv('autonomy.stage.review')).toEqual([
    'config',
    'delete',
    'autonomy.stage.review',
  ])
  expect(settingsCheckArgv({ user: true })).toEqual([
    'settings',
    'render',
    '--check',
    '--user',
    '--json',
  ])
  expect(settingsCheckArgv({ project: PLATFORM_NAME })).toEqual([
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
})

test('context accepts a null landing branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-context-null-landing-'))
  const executable = join(root, 'orch-context')
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\\n' '{"registered":true,"project":"fixture","rulings":{"value":"agent","scope":"built-in"},"release":{"value":"land","scope":"built-in","landing":null,"production":null},"stages":[],"text":"release: land (no landing branch declared) (built-in)"}'
`,
  )
  chmodSync(executable, 0o755)
  const prior = process.env.HUB_ORCH
  try {
    process.env.HUB_ORCH = executable
    const result = await contextGet('/fixture')
    expect(result.registered && result.release.landing).toBeNull()
  } finally {
    if (prior === undefined) delete process.env.HUB_ORCH
    else process.env.HUB_ORCH = prior
    rmSync(root, { recursive: true, force: true })
  }
})

test('settings check preserves an exit-one refusal with empty stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-settings-refusal-'))
  const executable = join(root, 'orch-refusal')
  writeFileSync(
    executable,
    "#!/bin/sh\nprintf '%s\\n' 'no signed-in record session; run orch record login' >&2\nexit 1\n",
  )
  chmodSync(executable, 0o755)
  const prior = process.env.HUB_ORCH
  try {
    process.env.HUB_ORCH = executable
    await expect(settingsCheck({ user: true })).rejects.toThrow(
      'no signed-in record session; run orch record login',
    )
  } finally {
    if (prior === undefined) delete process.env.HUB_ORCH
    else process.env.HUB_ORCH = prior
    rmSync(root, { recursive: true, force: true })
  }
})

test('owner-scoped doc wrappers never send an owner id', () => {
  expect(docArgv('list', { scope: 'canon', user: true })).toEqual([
    'doc',
    'list',
    '--scope',
    'canon',
    '--user',
    '--json',
  ])
  expect(
    docArgv('set', {
      scope: 'settings',
      user: true,
      slug: 'settings',
      title: 'settings',
      reason: 'change rule',
      expectedRevision: 'revision-1',
    }),
  ).toEqual([
    'doc',
    'set',
    'settings',
    '--scope',
    'settings',
    '--user',
    '--title',
    'settings',
    '--reason',
    'change rule',
    '--author',
    'hub-dashboard',
    '--expect',
    'revision-1',
    '--json',
  ])
})

test('operator file-ruling argv runs the verb through the orch seam with json', () => {
  expect(fileRulingArgv({ questionId: 7, as: 'doc' })).toEqual([
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
    answerWaitingArgv(42, [
      { questionId: 7, ruling: 'Use the existing shape' },
      { questionId: 8, ruling: 'Keep both' },
    ]),
  ).toEqual([
    'answer',
    '42',
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

test('the orch waiting client contract accepts a no-project item', () => {
  expect(
    OperatorWaitingItemSchema.parse({
      kind: 'question',
      id: 7,
      run_id: 42,
      project: null,
      task_key: null,
      session_id: null,
      question: 'Which?',
      options: [],
      recommendation: null,
      why: null,
      waiting_since: '2026-09-25',
      episode: '2026-09-25',
      answer_command: 'orch answer 42 --q7 "<ruling>"',
    }),
  ).toMatchObject({ project: null })
})

const runFixture = {
  id: 42,
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
  retry_of: null,
  turns: [
    {
      id: 42,
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

test('only the orch client invokes bin/orch', () => {
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
    return /bin\/orch/.test(source) || /\b(?:const|let|var)\s+ORCH\b/.test(source)
      ? [path.slice(root.length)]
      : []
  })
  expect(violations).toEqual([])
})

test('orch resolution accepts only executable files from override, checkout, and PATH', async () => {
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
  const checkoutCandidate = join(bundledRoot, 'bin', 'orch')
  mkdirSync(checkoutCandidate, { recursive: true })
  const first = join(root, 'first-bin')
  const second = join(root, 'second-bin')
  mkdirSync(join(first, 'orch'), { recursive: true })
  mkdirSync(second)
  const found = join(second, 'orch')
  writeFileSync(found, '#!/bin/sh\nexit 0\n')
  chmodSync(found, 0o755)
  const override = join(root, 'override-orch')
  mkdirSync(override)
  const priorOrch = process.env.HUB_ORCH
  const priorPath = process.env.PATH
  const priorHome = process.env[INSTALL_HOME_ENV]
  try {
    process.env[INSTALL_HOME_ENV] = bundledRoot
    process.env.HUB_ORCH = override
    process.env.PATH = `${first}:${second}`
    const bundled = await import(`${built.outputs[0]!.path}?test=${Date.now()}`)
    expect(bundled.resolveOrchExecutable()).toBe(found)

    process.env.PATH = first
    expect(() => bundled.resolveOrchExecutable()).toThrow(
      `HUB_ORCH override ${override}; checkout executable ${checkoutCandidate}; PATH lookup found nothing`,
    )
    delete process.env.HUB_ORCH
    expect(() => bundled.resolveOrchExecutable()).toThrow('HUB_ORCH override unset')
    expect(() => bundled.resolveOrchExecutable()).not.toThrow(/at call time|restart|moved|renamed/)
  } finally {
    if (priorOrch === undefined) delete process.env.HUB_ORCH
    else process.env.HUB_ORCH = priorOrch
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    if (priorHome === undefined) delete process.env[INSTALL_HOME_ENV]
    else process.env[INSTALL_HOME_ENV] = priorHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('dashboard scoring capability is private and bound to this hub process', () => {
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

describe('docArgv', () => {
  test('list with no filters', () => {
    expect(docArgv('list')).toEqual(['doc', 'list', '--json'])
  })

  test('list with scope', () => {
    expect(docArgv('list', { scope: 'global' })).toEqual([
      'doc',
      'list',
      '--scope',
      'global',
      '--json',
    ])
  })

  test('list with scope and subject', () => {
    expect(docArgv('list', { scope: 'project', subject: 'alpha' })).toEqual([
      'doc',
      'list',
      '--scope',
      'project',
      '--subject',
      'alpha',
      '--json',
    ])
  })

  test('get without subject', () => {
    expect(docArgv('get', { scope: 'global', subject: null, slug: 'hello' })).toEqual([
      'doc',
      'show',
      'hello',
      '--scope',
      'global',
      '--json',
    ])
  })

  test('get with subject', () => {
    expect(docArgv('get', { scope: 'project', subject: 'alpha', slug: 'hello' })).toEqual([
      'doc',
      'show',
      'hello',
      '--scope',
      'project',
      '--subject',
      'alpha',
      '--json',
    ])
  })

  test('set without subject does not put the body in argv', () => {
    const body = "quote' backtick` newline\n"
    const argv = docArgv('set', {
      scope: 'global',
      subject: null,
      slug: 'hello',
      title: 'Hi',
      body,
      reason: 'why',
    })
    expect(argv).toEqual([
      'doc',
      'set',
      'hello',
      '--scope',
      'global',
      '--title',
      'Hi',
      '--reason',
      'why',
      '--author',
      'hub-dashboard',
      '--json',
    ])
    expect(argv).not.toContain(body)
  })

  test('set with subject', () => {
    expect(
      docArgv('set', {
        scope: 'agent',
        subject: 'codex',
        slug: 'notes',
        title: 'Notes',
        reason: 'why',
      }),
    ).toEqual([
      'doc',
      'set',
      'notes',
      '--scope',
      'agent',
      '--subject',
      'codex',
      '--title',
      'Notes',
      '--reason',
      'why',
      '--author',
      'hub-dashboard',
      '--json',
    ])
  })

  test('set includes expect exactly when an expected revision is given', () => {
    const argv = docArgv('set', {
      scope: 'canon',
      subject: 'alpha',
      slug: '.agents/rules/docs.md',
      title: 'Docs',
      reason: 'updated',
      expectedRevision: 'revision-1',
    })
    const expectAt = argv.indexOf('--expect')
    expect(argv.filter((argument) => argument === '--expect')).toHaveLength(1)
    expect(argv.slice(expectAt, expectAt + 2)).toEqual(['--expect', 'revision-1'])
  })

  test('remove without subject', () => {
    expect(
      docArgv('remove', { scope: 'machine', subject: null, slug: 'host', reason: 'why' }),
    ).toEqual([
      'doc',
      'rm',
      'host',
      '--scope',
      'machine',
      '--reason',
      'why',
      '--author',
      'hub-dashboard',
      '--json',
    ])
  })

  test('remove with subject', () => {
    expect(
      docArgv('remove', { scope: 'job', subject: 'implement', slug: 'notes', reason: 'obsolete' }),
    ).toEqual([
      'doc',
      'rm',
      'notes',
      '--scope',
      'job',
      '--subject',
      'implement',
      '--reason',
      'obsolete',
      '--author',
      'hub-dashboard',
      '--json',
    ])
  })

  test('remove includes expect exactly when an expected revision is given', () => {
    const argv = docArgv('remove', {
      scope: 'canon',
      subject: 'alpha',
      slug: '.agents/rules/docs.md',
      reason: 'obsolete',
      expectedRevision: 'revision-1',
    })
    const expectAt = argv.indexOf('--expect')
    expect(argv.filter((argument) => argument === '--expect')).toHaveLength(1)
    expect(argv.slice(expectAt, expectAt + 2)).toEqual(['--expect', 'revision-1'])
  })

  test('subjects', () => {
    expect(docArgv('subjects')).toEqual(['doc', 'subjects', '--json'])
  })
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
