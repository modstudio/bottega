import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe,expect,spyOn,test } from 'bun:test'
import { mkdirSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { dir } from '../test/fixtures/store.ts'
import { createDocsMcpServer, fileIssue } from './mcp.ts'
import { upsertProject } from './projects.ts'

const hubCli = new URL('../../hub/src/cli.ts', import.meta.url).pathname
function migrateHub(path: string): void {
  const result = Bun.spawnSync([process.execPath, hubCli, 'migrate'], {
    env: { ...process.env, HUB_DB: path }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
}


describe('scoped operator docs', () => {
  test('MCP file_issue resolves orch at call time when the server starts in another project', async () => {
    const hubDb = join(dir, 'file-issue-call-time-hub.db')
    const foreignCwd = join(dir, 'file-issue-foreign-cwd')
    mkdirSync(foreignCwd, { recursive: true })
    migrateHub(hubDb)
    upsertProject({
      name: 'file-issue-foreign', path: foreignCwd, stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['FOREIGN'] },
    })
    upsertProject({
      name: PLATFORM_SLUG, path: join(dir, 'file-issue-platform'), stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['DEV'] },
    })
    const priorCwd = process.cwd()
    const priorHubDb = process.env.HUB_DB
    const priorHubOrch = process.env.HUB_ORCH
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.HUB_DB = hubDb
    process.env.CLAUDE_CODE_SESSION_ID = 'call-time-resolution-session'
    delete process.env.HUB_ORCH
    process.chdir(foreignCwd)
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-call-time-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'suggestion',
          what_happened: `The MCP server can file from a registered non-${PLATFORM_SLUG} cwd`,
          expected: 'The write resolves the orch executable when the call is made',
          evidence: 'The server was created after changing cwd to a project with no bin/orch',
          not_established: 'No behavior outside executable resolution is asserted',
          reporting_project: PLATFORM_SLUG,
        },
      })
      expect(filed.isError, JSON.stringify(filed)).not.toBe(true)
      expect(JSON.parse(((filed as any).content[0] as { text: string }).text)).toMatchObject({
        key: 'DEV-1', project: PLATFORM_SLUG,
      })
    } finally {
      process.chdir(priorCwd)
      if (priorHubDb === undefined) delete process.env.HUB_DB
      else process.env.HUB_DB = priorHubDb
      if (priorHubOrch === undefined) delete process.env.HUB_ORCH
      else process.env.HUB_ORCH = priorHubOrch
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = priorSession
      await client.close()
      await server.close()
      rmSync(foreignCwd, { recursive: true, force: true })
      for (const suffix of ['', '-shm', '-wal']) rmSync(`${hubDb}${suffix}`, { force: true })
    }
  })

  test('file_issue files while making a failed duplicate search explicit in output and body', async () => {
    const hubDb = join(dir, 'file-issue-search-failure-hub.db')
    const priorHubDb = process.env.HUB_DB
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.HUB_DB = hubDb
    migrateHub(hubDb)
    process.env.CLAUDE_CODE_SESSION_ID = 'search-failure-session'
    upsertProject({
      name: PLATFORM_SLUG, path: process.cwd(), stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['DEV'] },
    })
    const realSpawn = Bun.spawn.bind(Bun)
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((args: string[], options: object) => {
      if (args.includes('duplicates')) {
        return { stdout: '', stderr: 'duplicate search unavailable', exited: Promise.resolve(1) }
      }
      return realSpawn(args, options as any)
    }) as any)
    try {
      const filed = await fileIssue({
        kind: 'suggestion', what_happened: 'Preserve a report when duplicate search is unavailable',
        expected: 'The report is filed and the failed search is explicit',
        evidence: 'the search subprocess returned exit 1',
        not_established: 'why the search subprocess failed',
      }, { kind: 'session' }, PLATFORM_SLUG)
      expect(filed).toMatchObject({
        key: 'DEV-1', duplicate_search_error: 'duplicate search unavailable',
        title: '[SUGGESTION] Preserve a report when duplicate search is unavailable',
        title_shortened: false,
      })
      expect(filed).not.toHaveProperty('duplicates')
      const shown = Bun.spawnSync([
        new URL('../../bin/hub', import.meta.url).pathname,
        'task', 'show', filed.key, '--json',
      ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      expect(shown.exitCode).toBe(0)
      expect(JSON.parse(shown.stdout.toString()).task.body).toContain(
        'DUPLICATE SEARCH FAILED\nduplicate search unavailable',
      )
    } finally {
      spawn.mockRestore()
      rmSync(hubDb, { force: true })
      rmSync(`${hubDb}-shm`, { force: true })
      rmSync(`${hubDb}-wal`, { force: true })
      if (priorHubDb === undefined) delete process.env.HUB_DB
      else process.env.HUB_DB = priorHubDb
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    }
  })

})
