import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { program } from '../cli/program.ts'
import { setRawArgv } from '../commands/support.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { recordWorkflowExec } from './workflow-probe.ts'
import {
  workflowCommandOutcomePresentation as outcomePresentation,
  workflowCommandPresentation as presentation,
  registerCurrentWorkflowProject as registerCurrentProject,
  runWorkflowCommand as workflowCommand,
} from './workflow-store.fixture.ts'

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
        .query(
          "SELECT command,exit_code FROM probe WHERE kind='exec' ORDER BY created_at DESC,record_id DESC LIMIT 2",
        )
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

test('workflow exec --record-evidence records the payload row with the receiving store redaction', async () => {
  const priorDepth = process.env.BOTTEGA_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    delete process.env.BOTTEGA_DEPTH
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    const shown = outcomePresentation()
    const payload = {
      command: ['env'],
      cwd: process.cwd(),
      exitCode: 7,
      signal: null,
      output: 'token=ghp_exampletokenvalue\n',
      headCommit: null,
      preCommandHeadCommit: null,
    }

    await workflowCommand(['workflow', 'exec', '--record-evidence'], shown.presentation, {
      stdinText: async () => JSON.stringify(payload),
    })

    expect(shown.stdout[0]).toMatch(/^\d+$/)
    expect(
      db()
        .query('SELECT kind,exit_code,output_tail,session_id FROM probe WHERE number=?')
        .get(Number(shown.stdout[0])),
    ).toEqual({
      kind: 'exec',
      exit_code: 7,
      output_tail: '[withheld line: assignment]\n',
      session_id: 'architect-session',
    })
    // The receiver's status reports that the row was recorded, never the wrapped command's status.
    expect(shown.exitCodes).toEqual([])
  } finally {
    if (priorDepth === undefined) delete process.env.BOTTEGA_DEPTH
    else process.env.BOTTEGA_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})

test('workflow exec runs a child whose own argument is --record-evidence', async () => {
  const priorDepth = process.env.BOTTEGA_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    delete process.env.BOTTEGA_DEPTH
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    registerCurrentProject('workflow-exec-child-record-evidence')
    const shown = outcomePresentation()

    await workflowCommand(
      ['workflow', 'exec', '--', '/usr/bin/printf', '%s', '--record-evidence'],
      shown.presentation,
    )

    expect(shown.stdout[0]).toMatch(/^\d+$/)
    expect(
      db()
        .query(
          "SELECT command,exit_code FROM probe WHERE kind='exec' ORDER BY created_at DESC,record_id DESC LIMIT 1",
        )
        .get(),
    ).toEqual({
      command: JSON.stringify(['/usr/bin/printf', '%s', '--record-evidence']),
      exit_code: 0,
    })
    expect(shown.exitCodes).toEqual([0])
  } finally {
    if (priorDepth === undefined) delete process.env.BOTTEGA_DEPTH
    else process.env.BOTTEGA_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})

test('workflow exec refuses the separator-less child shape with the -- remedy', async () => {
  await expect(
    workflowCommand(
      ['workflow', 'exec', '/usr/bin/printf', '--record-evidence'],
      presentation([]),
      {
        stdinIsTTY: () => true,
      },
    ),
  ).rejects.toThrow('requires -- before the child command')
})

test('workflow exec --record-evidence refuses a stray token after the flag', async () => {
  await expect(
    workflowCommand(['workflow', 'exec', '--record-evidence', 'stray-token'], presentation([]), {
      stdinText: async () => '{}',
    }),
  ).rejects.toThrow('takes no command')
})

test('the receiving form refuses a payload without echoing its text', async () => {
  const priorDepth = process.env.BOTTEGA_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    delete process.env.BOTTEGA_DEPTH
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    const secret = 'ghp_123456789012345678901234567890123456'
    const before = (db().query('SELECT count(*) AS n FROM probe').get() as { n: number }).n
    const refusedBy = async (stdin: string): Promise<string> =>
      workflowCommand(['workflow', 'exec', '--record-evidence'], presentation([]), {
        stdinText: async () => stdin,
      }).then(
        () => 'the receiving form recorded the payload',
        (error: Error) => error.message,
      )

    // A payload whose output holds a secret-shaped line, refused for a missing exit code.
    const byField = await refusedBy(
      JSON.stringify({
        command: ['env'],
        cwd: process.cwd(),
        signal: null,
        output: `token=${secret}\n`,
        headCommit: null,
        preCommandHeadCommit: null,
      }),
    )
    expect(byField).toContain('exitCode must be an integer')
    expect(byField).not.toContain(secret)

    // Text that is not a payload at all: the parse error's own message quotes the input.
    const notJson = await refusedBy(secret)
    expect(notJson).toContain('it is not JSON')
    expect(notJson).not.toContain(secret)

    expect((db().query('SELECT count(*) AS n FROM probe').get() as { n: number }).n).toBe(before)
  } finally {
    if (priorDepth === undefined) delete process.env.BOTTEGA_DEPTH
    else process.env.BOTTEGA_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})
