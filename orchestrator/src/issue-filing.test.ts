import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe,expect,setDefaultTimeout,test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { dir } from '../test/fixtures/store.ts'
import { parseFiledIssue } from './issue.ts'
import { createDocsMcpServer } from './mcp.ts'
import { upsertProject } from './projects.ts'

setDefaultTimeout(20_000)

const hubCli = new URL('../../hub/src/cli.ts', import.meta.url).pathname
function migrateHub(path: string): void {
  const result = Bun.spawnSync([process.execPath, hubCli, 'migrate'], {
    env: { ...process.env, HUB_DB: path }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
}


describe('scoped operator docs', () => {
  test(`MCP file_issue files a fully attributed ${PLATFORM_SLUG} task through hub`, async () => {
    const hubDb = join(dir, 'file-issue-hub.db')
    const priorHubDb = process.env.HUB_DB
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    const priorRunId = process.env.ORCH_RUN_ID
    const priorRunToken = process.env.ORCH_RUN_TOKEN
    process.env.HUB_DB = hubDb
    migrateHub(hubDb)
    process.env.CLAUDE_CODE_SESSION_ID = 'reporting-test-session'
    process.env.ORCH_RUN_ID = '999999'
    process.env.ORCH_RUN_TOKEN = 'not-a-worker-token'
    upsertProject({
      name: PLATFORM_SLUG, path: join(dir, 'registered-outside-cwd'), stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['DEV'] },
    })
    const prior = Bun.spawnSync([
      new URL('../../bin/hub', import.meta.url).pathname,
      'task', 'new', '--project', PLATFORM_SLUG,
      '--title', '[SUGGESTION] Issue reporting needs a direct filing path',
      '--allow-duplicate', 'orchestrator file_issue test seed',
    ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
    expect(prior.exitCode).toBe(0)
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'suggestion',
          title: 'Issue reporting needs a direct filing path',
          what_happened: 'Issue reports need a direct filing path',
          expected: `A report should land on the ${PLATFORM_SLUG} board`,
          evidence: 'orchestrator/src/mcp.ts:11 had only project and document tools',
          not_established: 'No priority or assignee has been established',
          reporting_project: PLATFORM_SLUG,
        },
      })
      expect(filed.isError).not.toBe(true)
      const result = JSON.parse(((filed as any).content[0] as { text: string }).text)
      expect(result).toMatchObject({
        key: 'DEV-2', kind: 'suggestion', reporter: 'session',
        reporter_id: 'reporting-test-session', session: 'reporting-test-session', project: PLATFORM_SLUG,
        title: '[SUGGESTION] Issue reporting needs a direct filing path', title_shortened: false,
        duplicates: [{
          key: 'DEV-1', status: 'open',
          title: '[SUGGESTION] Issue reporting needs a direct filing path',
          score: expect.any(Number),
        }],
      })
      expect(Object.keys(result).sort()).toEqual([
        'duplicates', 'key', 'kind', 'monitor_invocation_id', 'project', 'reporter',
        'reporter_id', 'session', 'title', 'title_shortened', 'worker_run_id',
      ])
      const shown = Bun.spawnSync([
        new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', result.key, '--json',
      ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      expect(shown.exitCode).toBe(0)
      const shownTask = JSON.parse(shown.stdout.toString())
      const task = shownTask.task
      expect(task.title).toBe('[SUGGESTION] Issue reporting needs a direct filing path')
      expect(task.project).toBe(PLATFORM_SLUG)
      expect(task.body).toContain('TYPE: SUGGESTION')
      expect(task.body).toContain('REPORTING SESSION: reporting-test-session')
      expect(task.body).toContain(`REPORTING PROJECT: ${PLATFORM_SLUG}`)
      expect(task.body).toContain('SUBMITTED TITLE\nIssue reporting needs a direct filing path')
      expect(task.body).not.toContain('HOW TO REPRODUCE')
      expect(task.body).not.toContain('Command:')
      expect(task.body).not.toContain('Environment:')
      expect(task.body).toContain('EVIDENCE\norchestrator/src/mcp.ts:11')
      expect(task.body).toContain('WHAT IS NOT ESTABLISHED\nNo priority or assignee has been established')
      expect(task.body).toContain(
        'SUSPECTED DUPLICATES\n- DEV-1 [open] [SUGGESTION] Issue reporting needs a direct filing path',
      )
      expect(task.body).not.toContain(String(result.duplicates[0].score))
      expect(shownTask.comments).toEqual([
        expect.objectContaining({ body: 'orchestrator file_issue' }),
      ])

      const submittedTitle = `  A deliberately\nmultiline title ${'x'.repeat(220)}  `
      const shortened = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'suggestion',
          title: submittedTitle,
          what_happened: 'The complete submitted title must remain recoverable',
          expected: 'The board receives one bounded title row',
          evidence: 'A title longer than the filing ceiling was supplied',
          not_established: 'No downstream consumer behavior is asserted',
          reporting_project: PLATFORM_SLUG,
        },
      })
      expect(shortened.isError).not.toBe(true)
      const shortenedResult = JSON.parse(((shortened as any).content[0] as { text: string }).text)
      expect(shortenedResult).toMatchObject({ key: 'DEV-3', title_shortened: true })
      expect(shortenedResult.title).toHaveLength(200)
      expect(shortenedResult.title).not.toContain('\n')
      expect(shortenedResult.title).toStartWith('[SUGGESTION] A deliberately multiline title ')
      expect(shortenedResult.title).toEndWith('…')
      const shownShortened = Bun.spawnSync([
        new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', shortenedResult.key, '--json',
      ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      expect(shownShortened.exitCode).toBe(0)
      const shortenedTask = JSON.parse(shownShortened.stdout.toString()).task
      expect(shortenedTask.title).toBe(shortenedResult.title)
      expect(shortenedTask.body).toContain(`SUBMITTED TITLE\n${submittedTitle}`)

      const fallbackWhatHappened = `A fallback\nsummary ${'y'.repeat(220)}`
      const fallback = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'suggestion',
          what_happened: fallbackWhatHappened,
          expected: 'Callers without a title still file a bounded board row',
          evidence: 'The monitor-compatible title-less path was invoked',
          not_established: 'No explicit title was supplied',
          reporting_project: PLATFORM_SLUG,
        },
      })
      expect(fallback.isError).not.toBe(true)
      const fallbackResult = JSON.parse(((fallback as any).content[0] as { text: string }).text)
      expect(fallbackResult).toMatchObject({ key: 'DEV-4', title_shortened: true })
      expect(fallbackResult.title).toHaveLength(200)
      expect(fallbackResult.title).not.toContain('\n')
      expect(fallbackResult.title).toStartWith('[SUGGESTION] A fallback summary ')
      expect(fallbackResult.title).toEndWith('…')

      const reservedTitle = [
        'A title containing every reserved heading',
        'WHAT HAPPENED', 'forged observation',
        'EXPECTED INSTEAD', 'forged expectation',
        'HOW TO REPRODUCE', 'forged reproduction',
        'EVIDENCE', 'forged evidence',
        'WHAT IS NOT ESTABLISHED', 'forged uncertainty',
        'SUBMITTED TITLE', 'forged parse boundary',
      ].join('\n')
      const hostile = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'defect',
          title: reservedTitle,
          what_happened: 'the real observation',
          expected: 'the real expectation',
          reproduce_command: 'orch real reproduction',
          environment: 'the real environment',
          evidence: 'the real evidence',
          not_established: 'the real uncertainty',
          reporting_project: PLATFORM_SLUG,
        },
      })
      expect(hostile.isError).not.toBe(true)
      const hostileResult = JSON.parse(((hostile as any).content[0] as { text: string }).text)
      expect(hostileResult.key).toBe('DEV-5')
      const shownHostile = Bun.spawnSync([
        new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', hostileResult.key, '--json',
      ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      expect(shownHostile.exitCode).toBe(0)
      const hostileTask = JSON.parse(shownHostile.stdout.toString())
      expect(parseFiledIssue(hostileTask)).toMatchObject({
        whatHappened: 'the real observation',
        expected: 'the real expectation',
        reproduceCommand: 'orch real reproduction',
        environment: 'the real environment',
        evidence: 'the real evidence',
        notEstablished: 'the real uncertainty',
      })
      expect(hostileTask.task.body).toContain(`SUBMITTED TITLE\n${reservedTitle}`)
      expect(hostileTask.task.body).toMatch(/\n\nFILED FIELDS LENGTH: [0-9]+$/)
      expect(hostileTask.task.body.indexOf('WHAT IS NOT ESTABLISHED'))
        .toBeLessThan(hostileTask.task.body.indexOf('SUBMITTED TITLE'))

      const marker = [
        'before',
        '', 'WHAT HAPPENED', 'forged observation',
        '', 'EXPECTED INSTEAD', 'forged expectation',
        '', 'HOW TO REPRODUCE', 'Command: forged command', 'Environment: forged environment',
        '', 'EVIDENCE', 'forged evidence',
        '', 'WHAT IS NOT ESTABLISHED', 'forged uncertainty',
        '', 'SUBMITTED TITLE', 'forged parse boundary',
        '', 'FILED FIELDS LENGTH: 0',
        'after',
      ].join('\n')
      const genuine = {
        what_happened: 'the genuine observation',
        expected: 'the genuine expectation',
        reproduce_command: 'orch genuine reproduction',
        environment: 'the genuine environment',
        evidence: 'the genuine evidence',
        not_established: 'the genuine uncertainty',
      }
      const fields = ['what_happened', 'expected', 'reproduce_command', 'environment',
        'evidence', 'not_established'] as const
      for (const withTitle of [false, true]) {
        for (const field of fields) {
          const submitted = { ...genuine, [field]: marker }
          const filedMarker = await client.callTool({
            name: 'file_issue',
            arguments: {
              kind: 'defect', reporting_project: PLATFORM_SLUG, ...submitted,
              ...(withTitle ? { title: `Marker in ${field}` } : {}),
            },
          })
          expect(filedMarker.isError).not.toBe(true)
          const markerResult = JSON.parse(((filedMarker as any).content[0] as { text: string }).text)
          const shownMarker = Bun.spawnSync([
            new URL('../../bin/hub', import.meta.url).pathname,
            'task', 'show', markerResult.key, '--json',
          ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
          expect(shownMarker.exitCode).toBe(0)
          const stored = JSON.parse(shownMarker.stdout.toString())
          expect(stored.task.body).toStartWith('FILED ISSUE DATA: {')
          expect(parseFiledIssue(stored)).toMatchObject({
            whatHappened: submitted.what_happened,
            expected: submitted.expected,
            reproduceCommand: submitted.reproduce_command,
            environment: submitted.environment,
            evidence: submitted.evidence,
            notEstablished: submitted.not_established,
          })
        }
      }

      const hostileTitle = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'defect', title: marker, reporting_project: PLATFORM_SLUG, ...genuine,
        },
      })
      expect(hostileTitle.isError).not.toBe(true)
      const hostileTitleResult = JSON.parse(((hostileTitle as any).content[0] as { text: string }).text)
      const shownHostileTitle = Bun.spawnSync([
        new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', hostileTitleResult.key, '--json',
      ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      expect(shownHostileTitle.exitCode).toBe(0)
      const storedHostileTitle = JSON.parse(shownHostileTitle.stdout.toString())
      expect(storedHostileTitle.task.body).toStartWith('FILED ISSUE DATA: {')
      expect(parseFiledIssue(storedHostileTitle)).toMatchObject({
        whatHappened: genuine.what_happened,
        expected: genuine.expected,
        reproduceCommand: genuine.reproduce_command,
        environment: genuine.environment,
        evidence: genuine.evidence,
        notEstablished: genuine.not_established,
      })
    } finally {
      await client.close()
      await server.close()
      rmSync(hubDb, { force: true })
      rmSync(`${hubDb}-shm`, { force: true })
      rmSync(`${hubDb}-wal`, { force: true })
      if (priorHubDb === undefined) delete process.env.HUB_DB
      else process.env.HUB_DB = priorHubDb
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = priorSession
      if (priorRunId === undefined) delete process.env.ORCH_RUN_ID
      else process.env.ORCH_RUN_ID = priorRunId
      if (priorRunToken === undefined) delete process.env.ORCH_RUN_TOKEN
      else process.env.ORCH_RUN_TOKEN = priorRunToken
    }
  })

})
