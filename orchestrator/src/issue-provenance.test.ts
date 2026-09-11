import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe,expect,test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { addRun,createDocsMcpServer,db,dir,upsertProject } from '../test/fixture.ts'

const hubCli = new URL('../../hub/src/cli.ts', import.meta.url).pathname
function migrateHub(path: string): void {
  const result = Bun.spawnSync([process.execPath, hubCli, 'migrate'], {
    env: { ...process.env, HUB_DB: path }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
}


describe('scoped operator docs', () => {
  test('MCP file_issue derives worker provenance from the authenticated run environment', async () => {
    const hubDb = join(dir, 'worker-file-issue-hub.db')
    const priorHubDb = process.env.HUB_DB
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    const priorRunId = process.env.ORCH_RUN_ID
    const priorRunToken = process.env.ORCH_RUN_TOKEN
    process.env.HUB_DB = hubDb
    migrateHub(hubDb)
    delete process.env.CLAUDE_CODE_SESSION_ID
    upsertProject({
      name: PLATFORM_SLUG, path: process.cwd(), stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['DEV'] },
    })
    const runId = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET launch_cwd=?, launch_key=? WHERE id=?')
      .run(process.cwd(), 'DEV-218', runId)
    process.env.ORCH_RUN_ID = String(runId)
    process.env.ORCH_RUN_TOKEN = 'worker-file-token'
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const arguments_ = {
        kind: 'defect' as const,
        what_happened: 'A worker observed a reproducible failure',
        expected: 'The worker can preserve its finding directly',
        reproduce_command: 'bun test',
        environment: 'orch worker test fixture',
        evidence: `run ${runId} observed exit 1`,
        not_established: 'The underlying cause is not established',
      }
      const nullToken = await client.callTool({ name: 'file_issue', arguments: arguments_ })
      expect(nullToken.isError).toBe(true)
      expect(((nullToken as any).content[0] as { text: string }).text)
        .toContain('reporting session is not available')
      db().query('UPDATE run SET run_token=? WHERE id=?').run('worker-file-token', runId)
      process.env.ORCH_RUN_TOKEN = 'not-the-worker-token'
      const refused = await client.callTool({ name: 'file_issue', arguments: arguments_ })
      expect(refused.isError).toBe(true)
      expect(((refused as any).content[0] as { text: string }).text)
        .toContain('reporting session is not available')
      delete process.env.ORCH_RUN_ID
      delete process.env.ORCH_RUN_TOKEN
      const unidentified = await client.callTool({ name: 'file_issue', arguments: arguments_ })
      expect(unidentified.isError).toBe(true)
      expect(((unidentified as any).content[0] as { text: string }).text)
        .toContain('reporting session is not available')
      process.env.ORCH_RUN_ID = String(runId)
      process.env.ORCH_RUN_TOKEN = 'worker-file-token'
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: arguments_,
      })
      expect(filed.isError).not.toBe(true)
      const result = JSON.parse(((filed as any).content[0] as { text: string }).text)
      expect(result).toMatchObject({
        key: 'DEV-1', reporter: 'worker', reporter_id: `run:${runId}`,
        worker_run_id: runId, origin: 'DEV-218', session: null, project: PLATFORM_SLUG,
      })
      const shown = Bun.spawnSync([
        new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', result.key, '--json',
      ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      expect(shown.exitCode).toBe(0)
      const task = JSON.parse(shown.stdout.toString()).task
      expect(task.body).toContain(
        `\n\nFiled by orch run ${runId} (implement, codex) while working DEV-218\n`,
      )
      expect(task.body).toContain('REPORTER KIND: WORKER')
      expect(task.body).toContain(`REPORTING WORKER RUN: run:${runId}`)
      expect(task.body).toContain(`REPORTING PROJECT: ${PLATFORM_SLUG}`)
      expect(task.body).not.toContain('REPORTING SESSION:')

      db().query('UPDATE run SET launch_key=NULL WHERE id=?').run(runId)
      const keyless = await client.callTool({
        name: 'file_issue',
        arguments: { ...arguments_, what_happened: 'A keyless reader observed a reproducible failure' },
      })
      expect(keyless.isError).not.toBe(true)
      const keylessResult = JSON.parse(((keyless as any).content[0] as { text: string }).text)
      expect(keylessResult).toMatchObject({
        reporter: 'worker', worker_run_id: runId, origin: null, project: PLATFORM_SLUG,
      })
      const shownKeyless = Bun.spawnSync([
        new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', keylessResult.key, '--json',
      ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      expect(shownKeyless.exitCode).toBe(0)
      expect(JSON.parse(shownKeyless.stdout.toString()).task.body).toContain(
        `\n\nFiled by orch run ${runId} (implement, codex) while working with no task key\n`,
      )

      db().query('UPDATE run SET launch_cwd=NULL WHERE id=?').run(runId)
      const noProject = await client.callTool({
        name: 'file_issue',
        arguments: { ...arguments_, what_happened: 'A worker without a project observed a failure' },
      })
      expect(noProject.isError).toBe(true)
      expect(((noProject as any).content[0] as { text: string }).text)
        .toContain('reporting worker has no project origin')
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
