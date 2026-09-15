import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  decodeRunsJson,
  docArgv,
  projectArgv,
  startDashboardCapability,
  stopDashboardCapability,
} from './orch.ts'
import { encodeOrchRunLine, OrchBlockersSchema } from '../../shared/orch-contract.ts'

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

test('v1 and v2 run lines decode to the same run', () => {
  const v1 = encodeOrchRunLine(runFixture, 1)
  const v2 = encodeOrchRunLine(runFixture, 2)
  expect(decodeRunsJson(v1)).toEqual(decodeRunsJson(v2))
  expect(decodeRunsJson(v2)).toEqual([runFixture])
})

test('orch-owned run and blocker fields remain optional to hub', () => {
  const runWithoutTurn = {
    ...runFixture,
    turns: runFixture.turns.map(({ turn: _turn, ...turn }) => turn),
  }
  expect(decodeRunsJson(encodeOrchRunLine(runWithoutTurn, 2))).toEqual([runWithoutTurn])
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
  expect(() => decodeRunsJson(`\n${encodeOrchRunLine(runFixture, 2)}\nnot-json`)).toThrow('line 3')
})

test('an unknown envelope kind reports its physical line number', () => {
  const other = JSON.stringify({ schema_version: 2, kind: 'other', data: runFixture })
  expect(() => decodeRunsJson(`${encodeOrchRunLine(runFixture, 2)}\n\n${other}`)).toThrow('line 3')
})

test('only the orch client invokes bin/orch', () => {
  const root = new URL('.', import.meta.url).pathname
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
    entrypoints: [new URL('orch.ts', import.meta.url).pathname],
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
  try {
    process.env.HUB_ORCH = override
    process.env.PATH = `${first}:${second}`
    const bundled = await import(`${built.outputs[0]!.path}?test=${Date.now()}`)
    expect(bundled.resolveOrchExecutable()).toBe(found)

    process.env.PATH = first
    expect(() => bundled.resolveOrchExecutable()).toThrow(
      `HUB_ORCH override ${override}; checkout executable ${realpathSync(checkoutCandidate)}; PATH lookup found nothing`,
    )
    delete process.env.HUB_ORCH
    expect(() => bundled.resolveOrchExecutable()).toThrow('HUB_ORCH override unset')
    expect(() => bundled.resolveOrchExecutable()).not.toThrow(/at call time|restart|moved|renamed/)
  } finally {
    if (priorOrch === undefined) delete process.env.HUB_ORCH
    else process.env.HUB_ORCH = priorOrch
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
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
