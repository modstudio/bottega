import { expect, spyOn, test } from 'bun:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { program, run } from '../cli/program.ts'
import { setRawArgv } from '../commands/support.ts'
import { db, sessionId } from '../database/db.ts'
import { projectAt, upsertProject } from '../project/projects.ts'
import { rememberProjectSpace } from '../project-space.ts'
import { applyWorkflowCatalogueRow } from '../record/record-cache-workflow.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { commandOutcome, workflowProjectRefusal } from './workflow-commands.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { recordWorkflowExec, recordWorkflowProbe } from './workflow-probe.ts'
import {
  hostedWorkflowRepositoryFixture,
  installHostedWorkflowTreeFixture as installHostedWorkflowTree,
  workflowCommandOutcomePresentation as outcomePresentation,
  workflowCommandPresentation as presentation,
  publishCursorWorkflowFixture as publishCursorWorkflow,
  publishStaleLocalWorkflowFixture as publishStaleLocalWorkflow,
  workflowRecordedArtifact as recordedArtifact,
  registerCurrentWorkflowProject as registerCurrentProject,
  registerFixtureWorkflowProject as registerFixtureProject,
  registerOwningWorkflowProject as registerOwningProject,
  runWorkflowCommand as workflowCommand,
} from './workflow-store.fixture.ts'
import {
  promoteWorkflowLocal,
  resolvedWorkflowVersions,
  setWorkflowLocal,
  showResolvedWorkflow,
} from './workflows.ts'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

test('workflow preserves the unknown-verb refusal and exit status', async () => {
  const errors: string[] = []
  const error = spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))
  try {
    expect(await run(['workflow', 'bogus-verb'])).toBe(1)
  } finally {
    error.mockRestore()
  }
  expect(errors).toEqual([
    `unknown: ${PLATFORM_SLUG} workflow. Try list | show | set | promote | retire | fork | versions | render-check | compose | step | attach | next | await | rule | abandon | cursors | probe | exec | hydrate | import`,
  ])
})

test('workflow inspection reads only the current project space and stays local outside it', async () => {
  const local = db()
  const slug = 'inspection-resolution'
  const localDraft = setWorkflowLocal(
    slug,
    {
      title: 'Local inspection',
      description: 'Local catalogue definition.',
      arguments: [],
      modes: [
        {
          slug: 'local',
          title: 'Local',
          default: true,
          steps: ['verify'],
        },
      ],
    },
    'local inspection fixture',
    'test',
  )
  promoteWorkflowLocal(slug, localDraft.n, 'publish local inspection fixture', 'test')
  const localOnlySlug = 'inspection-local-only'
  const localOnlyDraft = setWorkflowLocal(
    localOnlySlug,
    {
      title: 'Local only inspection',
      description: 'Must not be visible inside a hosted-routed project.',
      arguments: [],
      modes: [],
    },
    'local-only inspection fixture',
    'test',
  )
  promoteWorkflowLocal(
    localOnlySlug,
    localOnlyDraft.n,
    'publish local-only inspection fixture',
    'test',
  )

  const project = 'inspection-resolution-project'
  const spaceId = newRecordId()
  registerCurrentProject(project)
  rememberProjectSpace(local, project, spaceId)
  const at = '2026-10-19T12:00:00.000Z'
  const catalogueId = newRecordId()
  applyWorkflowCatalogueRow(local, 'step_catalogue', {
    id: catalogueId,
    spaceId,
    slug: 'shared',
    generation: 1,
    createdAt: at,
  })
  applyWorkflowCatalogueRow(local, 'step_catalogue_version', {
    id: newRecordId(),
    spaceId,
    ownerId: catalogueId,
    n: 3,
    status: 'production',
    definition: JSON.stringify({
      ...productionStepCatalogue(local).definition,
      steps: [
        ...productionStepCatalogue(local).definition.steps,
        {
          slug: 'hosted-ordinal-check',
          title: 'Hosted ordinal check',
          body: 'This step exists only in the hosted mode layout.',
          floor: [],
          job: null,
          stage: 'review',
          autonomy: 'auto',
          needs: [],
        },
        {
          slug: 'inspection-check',
          title: 'Inspection check',
          body: 'Use {{tracker.server}}.',
          floor: ['recorded-artifact'],
          job: null,
          stage: 'review',
          autonomy: 'auto',
          needs: [],
        },
      ],
    }),
    author: 'hosted',
    reason: 'hosted catalogue fixture',
    createdAt: at,
    promotedAt: at,
    retiredAt: null,
  })
  const workflowId = newRecordId()
  applyWorkflowCatalogueRow(local, 'workflow', {
    id: workflowId,
    spaceId,
    slug,
    generation: 1,
    createdAt: at,
  })
  applyWorkflowCatalogueRow(local, 'workflow_version', {
    id: newRecordId(),
    spaceId,
    ownerId: workflowId,
    n: 4,
    status: 'production',
    definition: JSON.stringify({
      title: 'Hosted inspection',
      description: 'Hosted catalogue definition.',
      arguments: [],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: ['hosted-ordinal-check', 'inspection-check'],
        },
      ],
    }),
    author: 'hosted',
    reason: 'hosted workflow fixture',
    createdAt: at,
    promotedAt: at,
    retiredAt: null,
  })
  applyWorkflowCatalogueRow(local, 'workflow_version', {
    id: newRecordId(),
    spaceId,
    ownerId: workflowId,
    n: 5,
    status: 'draft',
    definition: JSON.stringify({
      title: 'Hosted inspection draft',
      description: 'Hosted draft catalogue definition.',
      arguments: [],
      modes: [],
    }),
    author: 'hosted',
    reason: 'hosted workflow draft fixture',
    createdAt: at,
    promotedAt: null,
    retiredAt: null,
  })

  const secondProject = 'inspection-resolution-second-project'
  const secondSpaceId = newRecordId()
  const secondStep = 'second-space-check'
  const secondWorkflow = 'second-space-workflow'
  registerFixtureProject(secondProject)
  rememberProjectSpace(local, secondProject, secondSpaceId)
  const secondCatalogueId = newRecordId()
  applyWorkflowCatalogueRow(local, 'step_catalogue', {
    id: secondCatalogueId,
    spaceId: secondSpaceId,
    slug: 'shared',
    generation: 1,
    createdAt: at,
  })
  applyWorkflowCatalogueRow(local, 'step_catalogue_version', {
    id: newRecordId(),
    spaceId: secondSpaceId,
    ownerId: secondCatalogueId,
    n: 2,
    status: 'production',
    definition: JSON.stringify({
      ...productionStepCatalogue(local).definition,
      steps: [
        ...productionStepCatalogue(local).definition.steps,
        {
          slug: secondStep,
          title: 'Second space check',
          body: 'Use {{second.only}}.',
          floor: ['recorded-artifact'],
          job: null,
          stage: 'review',
          autonomy: 'auto',
          needs: [],
        },
      ],
    }),
    author: 'hosted',
    reason: 'second hosted catalogue fixture',
    createdAt: at,
    promotedAt: at,
    retiredAt: null,
  })
  const secondWorkflowId = newRecordId()
  applyWorkflowCatalogueRow(local, 'workflow', {
    id: secondWorkflowId,
    spaceId: secondSpaceId,
    slug: secondWorkflow,
    generation: 1,
    createdAt: at,
  })
  applyWorkflowCatalogueRow(local, 'workflow_version', {
    id: newRecordId(),
    spaceId: secondSpaceId,
    ownerId: secondWorkflowId,
    n: 2,
    status: 'production',
    definition: JSON.stringify({
      title: 'Second hosted workflow',
      description: 'Uses a step available only in the second project space.',
      arguments: [],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: [secondStep],
        },
      ],
    }),
    author: 'hosted',
    reason: 'second hosted workflow fixture',
    createdAt: at,
    promotedAt: at,
    retiredAt: null,
  })

  const inside: string[] = []
  await workflowCommand(['workflow', 'list', '--json'], presentation(inside), {
    cwd: process.cwd(),
  })
  await workflowCommand(['workflow', 'show', slug, '--json'], presentation(inside), {
    cwd: process.cwd(),
  })
  await workflowCommand(['workflow', 'versions', slug, '--json'], presentation(inside), {
    cwd: process.cwd(),
  })
  await workflowCommand(['workflow', 'catalogue', 'show', '--json'], presentation(inside), {
    cwd: process.cwd(),
  })
  expect(
    (
      JSON.parse(inside[0]!) as {
        slug: string
        title: string
        production_n: number
        draft_n: number | null
      }[]
    ).find((row) => row.slug === slug),
  ).toEqual({ slug, title: 'Hosted inspection', production_n: 4, draft_n: 5 })
  expect(JSON.parse(inside[1]!).definition.title).toBe('Hosted inspection')
  expect(JSON.parse(inside[2]!)).toEqual([
    expect.objectContaining({ n: 4 }),
    expect.objectContaining({ n: 5 }),
  ])
  expect(JSON.parse(inside[3]!).n).toBe(3)
  expect(
    (JSON.parse(inside[0]!) as { slug: string }[]).some((row) => row.slug === localOnlySlug),
  ).toBe(false)
  expect(() => showResolvedWorkflow(localOnlySlug, undefined, project, local)).toThrow(
    `unknown workflow "${localOnlySlug}" in hosted space ${spaceId}`,
  )
  expect(() => resolvedWorkflowVersions(localOnlySlug, project, local)).toThrow(
    `unknown workflow "${localOnlySlug}" in hosted space ${spaceId}`,
  )

  const stepLines: string[] = []
  await workflowCommand(
    ['workflow', 'step', slug, '1', '--project', project],
    presentation(stepLines),
  )
  expect(stepLines.join('\n')).toContain('This step exists only in the hosted mode layout.')

  const renderLines: string[] = []
  await workflowCommand(['workflow', 'render-check'], presentation(renderLines))
  expect(renderLines).toContain(`${project}  checked workflow spaces: ${spaceId}`)
  expect(renderLines).toContain(
    `${project}  ${slug}  default  inspection-check  body  tracker.server`,
  )
  expect(renderLines).toContain(
    `${secondProject}  ${secondWorkflow}  default  ${secondStep}  body  second.only`,
  )
  expect(renderLines).not.toContain(
    `${project}  ${secondWorkflow}  default  ${secondStep}  body  second.only`,
  )

  const outside: string[] = []
  await workflowCommand(['workflow', 'list', '--json'], presentation(outside), {
    cwd: '/private/tmp/outside-registered-project',
  })
  await workflowCommand(['workflow', 'show', slug, '--json'], presentation(outside), {
    cwd: '/private/tmp/outside-registered-project',
  })
  expect(
    (JSON.parse(outside[0]!) as { slug: string; title: string }[]).find((row) => row.slug === slug)
      ?.title,
  ).toBe('Local inspection')
  expect(JSON.parse(outside[1]!).definition.title).toBe('Local inspection')
  expect(
    (JSON.parse(outside[0]!) as { slug: string }[]).some((row) => row.slug === localOnlySlug),
  ).toBe(true)
})

test('workflow hydrate check resolves hosted production from the worktree without BOTTEGA_MAIN_CHECKOUT', async () => {
  const fixture = hostedWorkflowRepositoryFixture('hydrate')
  const project = 'hydrate-hosted-worktree'
  registerOwningProject(project, fixture.mainCheckout)
  expect(projectAt(fixture.worktree)?.name).toBe(project)
  installHostedWorkflowTree(project, newRecordId(), fixture.worktree)
  publishStaleLocalWorkflow('hydrate-local-only')
  const priorMainCheckout = process.env.BOTTEGA_MAIN_CHECKOUT
  const result = outcomePresentation()
  try {
    delete process.env.BOTTEGA_MAIN_CHECKOUT
    await workflowCommand(
      ['workflow', 'hydrate', '--check', '--cwd', fixture.worktree],
      result.presentation,
    )
  } finally {
    if (priorMainCheckout === undefined) delete process.env.BOTTEGA_MAIN_CHECKOUT
    else process.env.BOTTEGA_MAIN_CHECKOUT = priorMainCheckout
    fixture.dispose()
  }
  expect(result.stdout).toEqual([])
  expect(result.exitCodes).toEqual([])
})

test('workflow import resolves hosted production from the worktree without BOTTEGA_MAIN_CHECKOUT', async () => {
  const fixture = hostedWorkflowRepositoryFixture('import')
  const project = 'import-hosted-worktree'
  registerOwningProject(project, fixture.mainCheckout)
  expect(projectAt(fixture.worktree)?.name).toBe(project)
  installHostedWorkflowTree(project, newRecordId(), fixture.worktree)
  publishStaleLocalWorkflow('import-local-only')
  const priorMainCheckout = process.env.BOTTEGA_MAIN_CHECKOUT
  const lines: string[] = []
  try {
    delete process.env.BOTTEGA_MAIN_CHECKOUT
    await workflowCommand(
      ['workflow', 'import', '--cwd', fixture.worktree, '--reason', 'unchanged hosted tree'],
      presentation(lines),
    )
  } finally {
    if (priorMainCheckout === undefined) delete process.env.BOTTEGA_MAIN_CHECKOUT
    else process.env.BOTTEGA_MAIN_CHECKOUT = priorMainCheckout
    fixture.dispose()
  }
  expect(lines.join('\n')).toMatch(/^catalogue: no change\n(?:.+: no change\n?)+$/)
})

test('workflow tree project refusal is only required for a configured record without an owner', () => {
  const input = { command: 'hydrate' as const, root: '/fixture/unowned' }
  expect(workflowProjectRefusal({ ...input, project: 'owned', recordConfigured: true })).toBeNull()
  expect(workflowProjectRefusal({ ...input, project: null, recordConfigured: false })).toBeNull()
  expect(workflowProjectRefusal({ ...input, project: null, recordConfigured: true })).toBe(
    'refusing workflow hydrate in /fixture/unowned: no registered project owns this directory\n' +
      "cleared by: run from a registered project's worktree, or pass --cwd for one",
  )
})

test('workflow hydrate and import refuse an unowned directory when a record is configured', async () => {
  const priorRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  try {
    await expect(
      workflowCommand(
        ['workflow', 'hydrate', '--check', '--cwd', repositoryRoot],
        presentation([]),
      ),
    ).rejects.toThrow(
      `refusing workflow hydrate in ${repositoryRoot}: no registered project owns this directory\n` +
        "cleared by: run from a registered project's worktree, or pass --cwd for one",
    )
    await expect(
      workflowCommand(
        ['workflow', 'import', '--cwd', repositoryRoot, '--reason', 'unowned tree'],
        presentation([]),
      ),
    ).rejects.toThrow(
      `refusing workflow import in ${repositoryRoot}: no registered project owns this directory\n` +
        "cleared by: run from a registered project's worktree, or pass --cwd for one",
    )
  } finally {
    if (priorRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorRecordApiUrl
  }
})

test('mode-less step command resolves autonomy from the fetched catalogue step', async () => {
  registerFixtureProject('mode-less-step')
  const step = productionStepCatalogue().definition.steps.find(({ slug }) => slug === 'verify')!
  const draft = setWorkflowLocal(
    'mode-less-step',
    {
      title: 'Mode-less step',
      description: 'Exercises the command without a workflow default mode.',
      arguments: [],
      modes: [{ slug: 'only', title: 'Only', entry: 'Use the only mode?', steps: [step.slug] }],
    },
    'test mode-less step command',
    'test',
  )
  promoteWorkflowLocal('mode-less-step', draft.n, 'publish', 'test')
  const lines: string[] = []

  await workflowCommand(
    ['workflow', 'step', 'mode-less-step', step.slug, '--project', 'mode-less-step'],
    {
      log: (line) => lines.push(line),
      error: () => {},
      setExitCode: () => {},
    },
  )

  expect(lines.join('\n')).toContain(`Autonomy: ${step.autonomy} (built-in)`)
})

test('workflow probe refuses a missing command', async () => {
  expect(workflowCommand(['workflow', 'probe', '--'], presentation([]))).rejects.toThrow(
    `${PLATFORM_SLUG} workflow probe needs a command after --`,
  )
})

test('workflow next refuses --basis without --self-ruling at the command edge', async () => {
  expect(
    workflowCommand(
      ['workflow', 'next', 'fixture', '--basis', 'specification line 4'],
      presentation([]),
    ),
  ).rejects.toThrow('--basis requires --self-ruling')
})

test('workflow exec refuses a missing command', async () => {
  expect(workflowCommand(['workflow', 'exec', '--'], presentation([]))).rejects.toThrow(
    `${PLATFORM_SLUG} workflow exec needs a command after --`,
  )
})

test('workflow probe requires a separator before the child command', async () => {
  expect(workflowCommand(['workflow', 'probe', '/usr/bin/true'], presentation([]))).rejects.toThrow(
    `${PLATFORM_SLUG} workflow probe requires -- before the child command; use ${PLATFORM_SLUG} workflow probe [--cwd <dir>] -- <command…>`,
  )
})

test('workflow exec requires a separator before the child command', async () => {
  expect(workflowCommand(['workflow', 'exec', '/usr/bin/true'], presentation([]))).rejects.toThrow(
    `${PLATFORM_SLUG} workflow exec requires -- before the child command; use ${PLATFORM_SLUG} workflow exec [--cwd <dir>] -- <command…>`,
  )
})

test('workflow probe and exec refuse an unknown option before the child separator', async () => {
  for (const verb of ['probe', 'exec']) {
    expect(await run(['workflow', verb, '--cdw', '.', '--', '/usr/bin/true'])).toBe(2)
  }
})

test('workflow attach reads text from stdin and prints its close reference', async () => {
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    process.env.CLAUDE_CODE_SESSION_ID = 'workflow-attach-cli'
    const cursor = (
      db()
        .query<{ id: number }, [string, string | null]>(
          `INSERT INTO workflow_cursor
            (record_id,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
             workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
             total_steps,created_at,updated_at,enforcement)
           VALUES (?,'fixture','attach-cli','default','','',?,1,1,'{}',0,'research','running',
                   '[]',NULL,1,'2026-10-05','2026-10-05','floors') RETURNING id`,
        )
        .get(newRecordId(), sessionId()) as { id: number }
    ).id
    const lines: string[] = []
    await workflowCommand(['workflow', 'attach', '--cursor', String(cursor)], presentation(lines), {
      stdinIsTTY: () => false,
      stdinText: async () => 'research from stdin',
    })
    expect(lines[0]).toMatch(/^attached-text:\d+$/)
    expect(
      db()
        .query(
          'SELECT cursor_id,step_ordinal,step_slug,body FROM workflow_step_text WHERE cursor_id=?',
        )
        .get(cursor),
    ).toEqual({
      cursor_id: cursor,
      step_ordinal: 1,
      step_slug: 'research',
      body: 'research from stdin',
    })
  } finally {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})

test('workflow attach declares no positional text argument', async () => {
  await expect(
    workflowCommand(
      ['workflow', 'attach', 'flow', 'argument text', '--cursor', '1'],
      presentation([]),
      { stdinIsTTY: () => true },
    ),
  ).rejects.toThrow("error: too many arguments for 'attach'. Expected 1 argument but got 2")
})

test('workflow child command invocation preserves an embedded separator in exec argv', async () => {
  registerCurrentProject('workflow-child-invocation')
  let received: { command: string[]; cwd: string } | undefined
  await workflowCommand(
    ['workflow', 'probe', '--', '/usr/bin/printf', '[%s]\\n', 'first', '--', 'tail'],
    presentation([]),
    {
      probeRunner: (input) => {
        received = input
        return { exitCode: 0, output: '' }
      },
    },
  )
  expect(received?.command).toEqual(['/usr/bin/printf', '[%s]\\n', 'first', '--', 'tail'])
})

test('Commander refuses workflow exec without a separator before running the child', async () => {
  const priorDepth = process.env.BOTTEGA_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    delete process.env.BOTTEGA_DEPTH
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    const before = (db().query('SELECT count(*) AS n FROM probe').get() as { n: number }).n
    setRawArgv(['workflow', 'exec', '/usr/bin/printf', '%s', '--cwd', 'child-dir', '--json'])

    await expect(
      program.parseAsync([
        'bun',
        'orch',
        'workflow',
        'exec',
        '/usr/bin/printf',
        '%s',
        '--cwd',
        'child-dir',
        '--json',
      ]),
    ).rejects.toThrow(
      `${PLATFORM_SLUG} workflow exec requires -- before the child command; use ${PLATFORM_SLUG} workflow exec [--cwd <dir>] -- <command…>`,
    )

    expect((db().query('SELECT count(*) AS n FROM probe').get() as { n: number }).n).toBe(before)
  } finally {
    if (priorDepth === undefined) delete process.env.BOTTEGA_DEPTH
    else process.env.BOTTEGA_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})

test('workflow probe and exec preserve child options after the real argv separator', async () => {
  registerCurrentProject('workflow-child-options')
  for (const verb of ['probe', 'exec']) {
    let received: { command: string[]; cwd: string } | undefined
    await workflowCommand(
      [
        'workflow',
        verb,
        '--cwd',
        '.',
        '--json',
        '--',
        '/usr/bin/printf',
        '%s%s%s%s',
        '--x',
        '--cwd',
        'child-dir',
        '--json',
      ],
      presentation([]),
      {
        probeRunner: (input) => {
          received = input
          return { exitCode: 0, output: '' }
        },
      },
    )
    const expected = {
      command: ['/usr/bin/printf', '%s%s%s%s', '--x', '--cwd', 'child-dir', '--json'],
      cwd: process.cwd(),
    }
    if (verb === 'probe') expect(received).toEqual(expected)
    else {
      const row = db()
        .query<{ command: string; cwd: string }, []>(
          "SELECT command,cwd FROM probe WHERE kind='exec' ORDER BY id DESC LIMIT 1",
        )
        .get()
      expect(row).toEqual({ command: JSON.stringify(expected.command), cwd: expected.cwd })
    }
  }
})

test('workflow exec service returns each child exit code after recording its row', async () => {
  const priorDepth = process.env.BOTTEGA_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    delete process.env.BOTTEGA_DEPTH
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    upsertProject({
      recordId: newRecordId(),
      name: 'workflow-exec-status',
      path: process.cwd(),
      stack: 'bun',
      settings: { gate: 'bun run check', trunk: 'main', docs: { protocol: 'orch-docs' } },
    })
    const passing = await recordWorkflowExec(['passing'], {
      registeredProject: true,
      runner: () => ({ exitCode: 0, output: '' }),
    })
    const failing = await recordWorkflowExec(['failing'], {
      registeredProject: true,
      runner: () => ({ exitCode: 7, output: '' }),
    })

    expect(passing.exitCode).toBe(0)
    expect(failing.exitCode).toBe(7)
    expect(
      db()
        .query("SELECT command,exit_code FROM probe WHERE kind='exec' ORDER BY id DESC LIMIT 2")
        .all()
        .reverse(),
    ).toEqual([
      { command: '["passing"]', exit_code: 0 },
      { command: '["failing"]', exit_code: 7 },
    ])
  } finally {
    if (priorDepth === undefined) delete process.env.BOTTEGA_DEPTH
    else process.env.BOTTEGA_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})

test('command outcome maps a signal to its shell status and error line', () => {
  expect(
    commandOutcome('exec', {
      id: 1,
      withheld: false,
      exitCode: -1,
      signal: 'SIGTERM',
      outputTail: '',
    }),
  ).toEqual({
    exitCode: 143,
    errorLine: `${PLATFORM_SLUG} workflow exec: command was killed by SIGTERM`,
  })
})

test('workflow probe service returns the recorded child exit code', async () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'workflow-probe-status',
    path: process.cwd(),
    stack: 'bun',
    settings: { gate: 'bun run check', trunk: 'main', docs: { protocol: 'orch-docs' } },
  })
  const result = await recordWorkflowProbe(['failing'], {
    runner: () => ({ exitCode: 9, output: '' }),
  })

  expect(commandOutcome('probe', result)).toEqual({ exitCode: 9 })
  expect(
    db().query("SELECT exit_code FROM probe WHERE kind='probe' ORDER BY id DESC LIMIT 1").get(),
  ).toEqual({ exit_code: 9 })
})

test('workflow probe prints a failed command exit and stored output tail after the id', async () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'workflow-probe-presentation-failure',
    path: process.cwd(),
    stack: 'bun',
    settings: { gate: 'bun run check', trunk: 'main', docs: { protocol: 'orch-docs' } },
  })
  const shown = outcomePresentation()

  await workflowCommand(['workflow', 'probe', '--', 'missing'], shown.presentation, {
    probeRunner: () => ({ exitCode: 127, output: 'command not found\n' }),
  })

  expect(shown.stdout).toHaveLength(1)
  expect(shown.stdout[0]).toMatch(/^\d+$/)
  expect(shown.stderr).toEqual([
    `${PLATFORM_SLUG} workflow probe: command exited 127`,
    'command not found\n',
  ])
  expect(shown.exitCodes).toEqual([127])
})

test('workflow probe success prints only the id', async () => {
  registerCurrentProject('workflow-probe-presentation-success')
  const shown = outcomePresentation()

  await workflowCommand(['workflow', 'probe', '--', 'passing'], shown.presentation, {
    probeRunner: () => ({ exitCode: 0, output: 'hidden success output\n' }),
  })

  expect(shown.stdout).toHaveLength(1)
  expect(shown.stdout[0]).toMatch(/^\d+$/)
  expect(shown.stderr).toEqual([])
  expect(shown.exitCodes).toEqual([0])
})

test('workflow probe failure prints the stored withheld marker instead of secret-shaped output', async () => {
  registerCurrentProject('workflow-probe-presentation-withheld')
  const shown = outcomePresentation()

  await workflowCommand(['workflow', 'probe', '--', 'failing'], shown.presentation, {
    probeRunner: () => ({ exitCode: 1, output: 'token=ghp_exampletokenvalue' }),
  })

  expect(shown.stderr).toEqual([
    `${PLATFORM_SLUG} workflow probe: command exited 1`,
    '[withheld line: assignment]',
  ])
  expect(shown.stderr.join('\n')).not.toContain('ghp_exampletokenvalue')
})

test('workflow probe failure says when the stored output tail is empty', async () => {
  registerCurrentProject('workflow-probe-presentation-empty')
  const shown = outcomePresentation()

  await workflowCommand(['workflow', 'probe', '--', 'silent-failure'], shown.presentation, {
    probeRunner: () => ({ exitCode: 2, output: '' }),
  })

  expect(shown.stderr).toEqual([`${PLATFORM_SLUG} workflow probe: command exited 2`, '(no output)'])
})

test('workflow probe JSON adds exitCode and outputTail only for a failure', async () => {
  registerCurrentProject('workflow-probe-presentation-json')
  const failing = outcomePresentation()
  await workflowCommand(['workflow', 'probe', '--', 'failing'], failing.presentation, {
    json: true,
    probeRunner: () => ({ exitCode: 7, output: 'failed\n' }),
  })
  expect(JSON.parse(failing.stdout[0]!)).toEqual({
    id: expect.any(Number),
    withheld: false,
    exitCode: 7,
    outputTail: 'failed\n',
  })
  expect(failing.stderr).toEqual([`${PLATFORM_SLUG} workflow probe: command exited 7`, 'failed\n'])

  const passing = outcomePresentation()
  await workflowCommand(['workflow', 'probe', '--', 'passing'], passing.presentation, {
    json: true,
    probeRunner: () => ({ exitCode: 0, output: 'not printed\n' }),
  })
  expect(JSON.parse(passing.stdout[0]!)).toEqual({
    id: expect.any(Number),
    withheld: false,
  })
  expect(passing.stderr).toEqual([])
})

test('next resolves an omitted mode to the composed cursor default', async () => {
  const slug = 'cursor-default-next'
  const project = 'cursor-default-next-project'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps: [step.slug] },
  ])
  composeWorkflowWithCursor(slug, project, undefined, { key: 'DEV-937-default' }, {})
  const lines: string[] = []

  await workflowCommand(
    [
      'workflow',
      'next',
      slug,
      '--project',
      project,
      '--arg',
      'key=DEV-937-default',
      ...recordedArtifact(project),
      '--note',
      'completed the report',
    ],
    presentation(lines),
  )

  expect(lines.join('\n')).toContain(`Workflow ${slug} for DEV-937-default is finished`)
})

test('cursor command without a default mode names the available modes', async () => {
  const slug = 'cursor-no-default'
  const project = 'cursor-no-default-project'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', entry: 'Prepare a report?', steps: [step.slug] },
    { slug: 'repair', title: 'Repair', entry: 'Make a repair?', steps: [step.slug] },
  ])

  expect(
    workflowCommand(
      ['workflow', 'next', slug, '--project', project, '--arg', 'key=DEV-937-no-default'],
      presentation([]),
    ),
  ).rejects.toThrow(
    `${PLATFORM_SLUG} workflow next cannot resolve a default mode for workflow "${slug}"; modes: report, repair; pass --mode <slug>`,
  )
})

test('next preserves an explicit mode', async () => {
  const slug = 'cursor-explicit-next'
  const project = 'cursor-explicit-next-project'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps: [step.slug] },
    { slug: 'repair', title: 'Repair', steps: [step.slug] },
  ])
  composeWorkflowWithCursor(slug, project, 'repair', { key: 'DEV-937-explicit' }, {})
  const lines: string[] = []

  await workflowCommand(
    [
      'workflow',
      'next',
      slug,
      '--project',
      project,
      '--mode',
      'repair',
      '--arg',
      'key=DEV-937-explicit',
      ...recordedArtifact(project),
      '--note',
      'completed the repair',
    ],
    presentation(lines),
  )

  expect(lines.join('\n')).toContain(`Workflow ${slug} for DEV-937-explicit is finished`)
})

test('mode-less cursor verbs keep using the cursor mode after the workflow default changes', async () => {
  const slug = 'cursor-pinned-default'
  const project = 'cursor-pinned-default-project'
  const key = 'DEV-937-pinned'
  const catalogue = productionStepCatalogue().definition.steps
  const steps = [
    catalogue.find(({ slug }) => slug === 'blast-radius')!.slug,
    catalogue.find(({ slug }) => slug === 'fix-defect-triage')!.slug,
  ]
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps },
    { slug: 'repair', title: 'Repair', steps },
  ])
  composeWorkflowWithCursor(slug, project, undefined, { key }, {})
  const changed = setWorkflowLocal(
    slug,
    {
      title: `Cursor command ${slug}`,
      description: 'Exercises pinned cursor mode resolution.',
      arguments: [{ name: 'key', required: true, description: 'Task key.' }],
      modes: [
        { slug: 'report', title: 'Report', steps },
        { slug: 'repair', title: 'Repair', default: true, steps },
      ],
    },
    'change the default mode',
    'test',
  )
  promoteWorkflowLocal(slug, changed.n, 'publish changed default', 'test')
  const lines: string[] = []
  const command = (verb: string, ...tail: string[]) =>
    workflowCommand(
      ['workflow', verb, slug, '--project', project, '--arg', `key=${key}`, ...tail],
      presentation(lines),
    )

  await command('next', ...recordedArtifact(project), '--note', 'completed the report')
  await command('await', '--question', 'which ruling applies?')
  await command('abandon', '--reason', 'operator stopped')

  expect(lines.join('\n')).toMatch(
    new RegExp(`workflow ${slug} is awaiting ruling question \\d+ at step 2 fix-defect-triage`),
  )
  expect(lines.join('\n')).toContain(
    `Workflow ${slug} for ${key} was abandoned at step 2 fix-defect-triage`,
  )
})

test('every CLI cursor verb routes by handle, including handle-only abandon', async () => {
  const slug = 'cursor-handle-verbs'
  const project = 'cursor-handle-verbs-project'
  const catalogue = productionStepCatalogue().definition.steps
  const steps = [
    catalogue.find(({ slug }) => slug === 'blast-radius')!.slug,
    catalogue.find(({ slug }) => slug === 'fix-defect-triage')!.slug,
  ]
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [{ slug: 'report', title: 'Report', default: true, steps }])
  const first = composeWorkflowWithCursor(slug, project, 'report', { key: 'DEV-1082-A' }, {})
  const second = composeWorkflowWithCursor(slug, project, 'report', { key: 'DEV-1082-B' }, {})
  const firstCursor = first.cursor!.id
  const secondCursor = second.cursor!.id
  db()
    .query("UPDATE workflow_cursor SET enforcement='note-only' WHERE id IN (?,?)")
    .run(firstCursor, secondCursor)
  const lines: string[] = []
  const command = (verb: string, cursor: number, ...tail: string[]) =>
    workflowCommand(
      [
        'workflow',
        verb,
        slug,
        ...(verb === 'step' ? [steps[0]!] : []),
        '--cursor',
        String(cursor),
        ...tail,
      ],
      presentation(lines),
    )

  await command('step', firstCursor, '--arg', 'key=DEV-1082-A')
  await command('next', firstCursor, '--note', 'closed with supplied workflow')
  await workflowCommand(
    ['workflow', 'next', '--cursor', String(secondCursor), '--note', 'closed by handle'],
    presentation(lines),
  )
  await command('await', secondCursor, '--question', 'Proceed by handle?')
  await command('rule', secondCursor, '--ruling', 'Proceed.', '--from-operator')
  await workflowCommand(
    ['workflow', 'abandon', '--cursor', String(secondCursor), '--reason', 'stopped by handle'],
    presentation(lines),
  )

  expect(lines.join('\n')).toContain(`cursor ${firstCursor}`)
  expect(
    db().query('SELECT ordinal,state FROM workflow_cursor WHERE id=?').get(firstCursor),
  ).toEqual({ ordinal: 1, state: 'running' })
  expect(db().query('SELECT state FROM workflow_cursor WHERE id=?').get(secondCursor)).toEqual({
    state: 'abandoned',
  })
})

test('a cursor refuses a supplied workflow or project that differs from its row', async () => {
  const slug = 'cursor-identity-mismatch'
  const project = 'cursor-identity-mismatch-project'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps: [step.slug] },
  ])
  const opened = composeWorkflowWithCursor(slug, project, 'report', { key: 'DEV-1223' }, {})
  const cursor = String(opened.cursor!.id)

  await expect(
    workflowCommand(
      ['workflow', 'next', 'another-workflow', '--cursor', cursor, '--note', 'mismatch'],
      presentation([]),
    ),
  ).rejects.toThrow(`workflow mismatch: supplied "another-workflow", cursor has "${slug}"`)
  await expect(
    workflowCommand(
      [
        'workflow',
        'next',
        slug,
        '--project',
        'another-project',
        '--cursor',
        cursor,
        '--note',
        'mismatch',
      ],
      presentation([]),
    ),
  ).rejects.toThrow(`project mismatch: supplied "another-project", cursor has "${project}"`)
})

test('mode-less cursor command refuses active cursors in multiple modes', async () => {
  const slug = 'cursor-ambiguous-mode'
  const project = 'cursor-ambiguous-mode-project'
  const key = 'DEV-937-ambiguous'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps: [step.slug] },
    { slug: 'repair', title: 'Repair', steps: [step.slug] },
  ])
  composeWorkflowWithCursor(slug, project, 'report', { key }, {})
  composeWorkflowWithCursor(slug, project, 'repair', { key }, {})

  expect(
    workflowCommand(
      ['workflow', 'next', slug, '--project', project, '--arg', `key=${key}`],
      presentation([]),
    ),
  ).rejects.toThrow(
    `${PLATFORM_SLUG} workflow next cannot resolve a mode for workflow "${slug}"; ` +
      'active cursor modes: repair, report; pass --mode <slug>',
  )
})
