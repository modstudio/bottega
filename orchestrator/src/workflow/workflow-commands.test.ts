import { expect, test } from 'bun:test'
import { program } from '../cli/program.ts'
import { db, sessionId } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import {
  commandOutcome,
  workflowChildCommandInvocation,
  workflowCommand,
  workflowImportLines,
} from './workflow-commands.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { recordWorkflowExec, recordWorkflowProbe } from './workflow-probe.ts'
import { promoteWorkflow, setWorkflow, type WorkflowDefinition } from './workflows.ts'

const presentation = (lines: string[]) => ({
  log: (line: string) => lines.push(line),
  error: () => {},
  setExitCode: () => {},
})

const outcomePresentation = () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCodes: number[] = []
  return {
    stdout,
    stderr,
    exitCodes,
    presentation: {
      log: (line: string) => stdout.push(line),
      error: (line: string) => stderr.push(line),
      setExitCode: (code: number) => exitCodes.push(code),
    },
  }
}

const recordedArtifact = (project: string) => {
  const row = db()
    .query<{ id: number }, [string, string]>(
      `INSERT INTO doc (scope,subject,slug,title,body,delivery,created_at,updated_at,project_id)
       SELECT 'project', ?, 'floor-artifact', 't', 'b', 'inject', 't', 't', id
         FROM project WHERE name=?
       RETURNING id`,
    )
    .get(project, project) as { id: number }
  return [`--artifact`, `doc:${row.id}`] as const
}

const registerFixtureProject = (name: string) =>
  upsertProject({
    name,
    path: `/fixture/${name}`,
    stack: 'bun',
    settings: { gate: 'bun run check', trunk: 'main', docs: { protocol: 'orch-docs' } },
  })

const registerCurrentProject = (name: string) =>
  upsertProject({
    name,
    path: process.cwd(),
    stack: 'bun',
    settings: { gate: 'bun run check', trunk: 'main', docs: { protocol: 'orch-docs' } },
  })

test('workflow import reports a sequence-only draft as a change', () => {
  expect(workflowImportLines({ steps: [], sequences: ['review'], workflows: [] })).toEqual([
    'drafted sequence review',
  ])
})

const publishCursorWorkflow = (slug: string, modes: WorkflowDefinition['modes']) => {
  const draft = setWorkflow(
    slug,
    {
      title: `Cursor command ${slug}`,
      description: 'Exercises cursor mode resolution.',
      arguments: [{ name: 'key', required: true, description: 'Task key.' }],
      modes,
    },
    'test cursor mode resolution',
    'test',
  )
  promoteWorkflow(slug, draft.n, 'publish', 'test')
}

test('mode-less step command resolves autonomy from the fetched catalogue step', async () => {
  registerFixtureProject('mode-less-step')
  const step = productionStepCatalogue().definition.steps.find(({ slug }) => slug === 'verify')!
  const draft = setWorkflow(
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
  promoteWorkflow('mode-less-step', draft.n, 'publish', 'test')
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
    'orch workflow probe needs a command after --',
  )
})

test('workflow exec refuses a missing command', async () => {
  expect(workflowCommand(['workflow', 'exec', '--'], presentation([]))).rejects.toThrow(
    'orch workflow exec needs a command after --',
  )
})

test('workflow probe requires a separator before the child command', async () => {
  expect(workflowCommand(['workflow', 'probe', '/usr/bin/true'], presentation([]))).rejects.toThrow(
    'orch workflow probe requires -- before the child command; use orch workflow probe [--cwd <dir>] -- <command…>',
  )
})

test('workflow exec requires a separator before the child command', async () => {
  expect(workflowCommand(['workflow', 'exec', '/usr/bin/true'], presentation([]))).rejects.toThrow(
    'orch workflow exec requires -- before the child command; use orch workflow exec [--cwd <dir>] -- <command…>',
  )
})

test('workflow attach reads text from stdin and prints its close reference', async () => {
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    process.env.CLAUDE_CODE_SESSION_ID = 'workflow-attach-cli'
    const cursor = (
      db()
        .query<{ id: number }, [string | null]>(
          `INSERT INTO workflow_cursor
            (project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
             workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
             total_steps,created_at,updated_at,enforcement)
           VALUES ('fixture','attach-cli','default','','',?,1,1,'{}',0,'research','running',
                   '[]',NULL,1,'2026-10-05','2026-10-05','floors') RETURNING id`,
        )
        .get(sessionId()) as { id: number }
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

test('workflow attach refuses text in an argument', async () => {
  await expect(
    workflowCommand(['workflow', 'attach', 'argument text', '--cursor', '1'], presentation([]), {
      stdinIsTTY: () => true,
    }),
  ).rejects.toThrow('workflow text is not accepted as an argument')
})

test('workflow child command invocation preserves an embedded separator in exec argv', () => {
  expect(
    workflowChildCommandInvocation(
      ['exec'],
      [
        'bun',
        'orch',
        'workflow',
        'exec',
        '--',
        '/usr/bin/printf',
        '[%s]\\n',
        'first',
        '--',
        'tail',
      ],
      {},
    ),
  ).toEqual({
    argv: ['workflow', 'exec', '--', '/usr/bin/printf', '[%s]\\n', 'first', '--', 'tail'],
    options: { cwd: undefined, json: false },
  })
})

test('Commander refuses workflow exec without a separator before running the child', async () => {
  const priorDepth = process.env.ORCH_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    delete process.env.ORCH_DEPTH
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    const before = (db().query('SELECT count(*) AS n FROM probe').get() as { n: number }).n

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
      'orch workflow exec requires -- before the child command; use orch workflow exec [--cwd <dir>] -- <command…>',
    )

    expect((db().query('SELECT count(*) AS n FROM probe').get() as { n: number }).n).toBe(before)
  } finally {
    if (priorDepth === undefined) delete process.env.ORCH_DEPTH
    else process.env.ORCH_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})

test('workflow child command invocation keeps cwd and json options out of exec argv', () => {
  expect(
    workflowChildCommandInvocation(
      ['exec'],
      [
        'bun',
        'orch',
        'workflow',
        'exec',
        '--cwd',
        '.',
        '--',
        '/usr/bin/printf',
        '%s%s%s%s',
        '--x',
        '--cwd',
        'child-dir',
        '--json',
      ],
      { cwd: '.', json: true },
    ),
  ).toEqual({
    argv: [
      'workflow',
      'exec',
      '--',
      '/usr/bin/printf',
      '%s%s%s%s',
      '--x',
      '--cwd',
      'child-dir',
      '--json',
    ],
    options: { cwd: '.', json: true },
  })
})

test('workflow exec service returns each child exit code after recording its row', async () => {
  const priorDepth = process.env.ORCH_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    delete process.env.ORCH_DEPTH
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    upsertProject({
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
    if (priorDepth === undefined) delete process.env.ORCH_DEPTH
    else process.env.ORCH_DEPTH = priorDepth
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
    errorLine: 'orch workflow exec: command was killed by SIGTERM',
  })
})

test('workflow probe service returns the recorded child exit code', async () => {
  upsertProject({
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
  expect(shown.stderr).toEqual(['orch workflow probe: command exited 127', 'command not found\n'])
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
    'orch workflow probe: command exited 1',
    '[withheld: secret-shaped content]',
  ])
  expect(shown.stderr.join('\n')).not.toContain('ghp_exampletokenvalue')
})

test('workflow probe failure says when the stored output tail is empty', async () => {
  registerCurrentProject('workflow-probe-presentation-empty')
  const shown = outcomePresentation()

  await workflowCommand(['workflow', 'probe', '--', 'silent-failure'], shown.presentation, {
    probeRunner: () => ({ exitCode: 2, output: '' }),
  })

  expect(shown.stderr).toEqual(['orch workflow probe: command exited 2', '(no output)'])
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
  expect(failing.stderr).toEqual(['orch workflow probe: command exited 7', 'failed\n'])

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
    `orch workflow next cannot resolve a default mode for workflow "${slug}"; modes: report, repair; pass --mode <slug>`,
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
  const changed = setWorkflow(
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
  promoteWorkflow(slug, changed.n, 'publish changed default', 'test')
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
        '--project',
        project,
        '--cursor',
        String(cursor),
        ...tail,
      ],
      presentation(lines),
    )

  await command('step', firstCursor, '--arg', 'key=DEV-1082-A')
  await command('next', firstCursor, '--note', 'closed by handle')
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
    `orch workflow next cannot resolve a mode for workflow "${slug}"; ` +
      'active cursor modes: repair, report; pass --mode <slug>',
  )
})
