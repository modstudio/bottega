import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { consumeDoc, removeDoc, setDoc } from '../../test/fixtures/docs.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../db.ts'
import { JOBS } from '../jobs.ts'
import { createDocsMcpServer } from '../mcp/mcp.ts'
import { portCommand } from '../porting/port-commands.ts'
import {
  baselineForPair,
  ledgerRef,
  listDoctrineRules,
  listLedgerRefs,
  listSkips,
  type PortPair,
} from '../porting/porting.ts'
import { upsertProject } from '../project/projects.ts'
import { reviewCommand } from '../review-commands.ts'
import {
  removeDoc as deleteDoc,
  diffDocRevisions,
  docSubjects,
  getDoc,
  listDocRevisions,
  parseResumeFrontmatter,
  restoreDoc,
  setDoc as writeDoc,
} from './docs.ts'

const listPairs = () => db().query('SELECT * FROM port_pair ORDER BY id').all() as PortPair[]

async function command(args: string[], stdin = '') {
  const values = new Map<string, string>()
  const present = new Set<string>()
  for (let i = 0; i < args.length; i++)
    if (args[i]?.startsWith('--')) {
      const name = args[i]!.slice(2)
      present.add(name)
      if (args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) values.set(name, args[++i]!)
    }
  const out: string[] = []
  const err: string[] = []
  let code = 0
  const flags = {
    has: (name: string) => present.has(name),
    flag: (name: string) => values.get(name),
  }
  const presentation = {
    log: (...parts: unknown[]) => out.push(parts.join(' ')),
    usage: (): never => {
      throw new Error('unexpected usage')
    },
    error: (...parts: unknown[]) => err.push(parts.join(' ')),
    write: (value: string) => out.push(value),
    writeStdout: async (value: string) => {
      out.push(value)
    },
    stdinText: async () => stdin,
    stdinIsTTY: false,
    cwd: () => process.cwd(),
    exitCode: (value: number) => {
      code = value
    },
  }
  try {
    if (args[0] === 'port') await portCommand(args[1], args[2], args, flags, presentation)
    else if (args[0] === 'review') await reviewCommand(args[1], args, flags, presentation)
  } catch (error) {
    code = 1
    err.push((error as Error).message)
  }
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('scoped operator docs', () => {
  test('orch port exposes baseline, skip, ledger resolution, correction, and doctrine lifecycle', async () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    upsertProject({
      name: 'target-invented',
      path: '/w/target',
      settings: { keyPrefixes: ['TGT'] },
    })

    expect(
      (await command(['port', 'baseline', 'set', 'source-invented', 'target-invented', 'abc']))
        .code,
    ).toBe(0)
    const pair = listPairs()[0]!
    expect(baselineForPair(pair.id)?.source_commit).toBe('abc')
    expect(
      (
        await command([
          'port',
          'skip',
          'add',
          'source-invented',
          'target-invented',
          'old-feature',
          '--reason',
          'superseded',
        ])
      ).code,
    ).toBe(0)
    expect(listSkips(pair.id)).toMatchObject([{ candidate: 'old-feature', reason: 'superseded' }])

    const sources = JSON.stringify([
      { project: 'source-invented', commits: ['abc'], paths: ['src/a.ts'], note: 'origin' },
    ])
    expect(
      (
        await command([
          'port',
          'ref',
          'set',
          'TGT-7',
          '--sources',
          sources,
          '--note',
          'native task',
        ])
      ).code,
    ).toBe(0)
    expect((await command(['port', 'ref', 'resolve', 'TGT-7', '--json'])).code).toBe(0)
    expect(ledgerRef('TGT-7')).toMatchObject({ task_key: 'TGT-7', resolved_at: expect.any(String) })
    expect(listLedgerRefs()).toEqual([])
    expect(listLedgerRefs(true)).toHaveLength(1)
    expect((await command(['port', 'ref', 'delete-error', 'TGT-7'])).code).toBe(0)
    expect(ledgerRef('TGT-7')).toBeNull()

    expect(
      (
        await command(
          ['port', 'doctrine', 'add', '4', '--title', 'Native', '--json'],
          'Adapt natively.',
        )
      ).code,
    ).toBe(0)
    expect((await command(['port', 'doctrine', 'retire', '4'])).code).toBe(0)
    expect(listDoctrineRules(false)).toEqual([])
    expect(listDoctrineRules(true)).toMatchObject([{ number: 4, retired_at: expect.any(String) }])
  }, 20_000)

  test('orch port refuses unknown registered project names and task prefixes', async () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    const unknown = await command(['port', 'baseline', 'show', 'source-invented', 'missing'])
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain('unknown project "missing"')
    const sources = JSON.stringify([
      { project: 'source-invented', commits: [], paths: [], note: '' },
    ])
    const prefix = await command([
      'port',
      'ref',
      'set',
      'NONE-1',
      '--sources',
      sources,
      '--note',
      '',
    ])
    expect(prefix.code).toBe(1)
    expect(prefix.err).toContain('no registered project owns task key')
  })

  test('nested command errors name the recognized group and list its verbs', async () => {
    expect(await command(['port', 'doctrine', 'show', '7'])).toMatchObject({
      code: 1,
      err: expect.stringContaining('unknown: orch port doctrine show. Try list | add | retire'),
    })
    expect(await command(['port', 'ref'])).toMatchObject({
      code: 1,
      err: expect.stringContaining(
        'unknown: orch port ref. Try list | show | set | resolve | delete-error',
      ),
    })
    expect(await command(['review', 'inspect'])).toMatchObject({
      code: 1,
      err: expect.stringContaining(
        'unknown: orch review inspect. Try tier | record | triage | complete | calibration',
      ),
    })
    expect(await command(['review'])).toMatchObject({
      code: 1,
      err: expect.stringContaining(
        'unknown: orch review. Try tier | record | triage | complete | calibration',
      ),
    })
  }, 20_000)

  test('MCP port tools use registered names and preserve resolved provenance', async () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    upsertProject({
      name: 'target-invented',
      path: '/w/target',
      settings: { keyPrefixes: ['TGT'] },
    })
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-port-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const value = (result: unknown) => {
      if (!result || typeof result !== 'object' || !('content' in result)) {
        throw new Error('tool result has no content')
      }
      const content = result.content
      if (!Array.isArray(content) || !content[0] || typeof content[0].text !== 'string') {
        throw new Error('tool result has no text content')
      }
      return JSON.parse(content[0].text)
    }
    try {
      await client.callTool({
        name: 'set_port_baseline',
        arguments: {
          source: 'source-invented',
          target: 'target-invented',
          source_commit: 'abc',
        },
      })
      await client.callTool({
        name: 'record_port_skip',
        arguments: {
          source: 'source-invented',
          target: 'target-invented',
          candidate: 'old',
          reason: 'done elsewhere',
        },
      })
      await client.callTool({
        name: 'set_port_ledger_ref',
        arguments: {
          task_key: 'TGT-8',
          note: 'native',
          sources: [
            { project: 'source-invented', commits: ['abc'], paths: ['src/a.ts'], note: 'origin' },
          ],
        },
      })
      const resolved = await client.callTool({
        name: 'resolve_port_ledger_ref',
        arguments: { task_key: 'TGT-8' },
      })
      expect(value(resolved)).toMatchObject({ task_key: 'TGT-8', resolved_at: expect.any(String) })
      const active = await client.callTool({ name: 'list_port_ledger_refs', arguments: {} })
      const all = await client.callTool({
        name: 'list_port_ledger_refs',
        arguments: { include_resolved: true },
      })
      expect(value(active)).toEqual([])
      expect(value(all)).toMatchObject([{ task_key: 'TGT-8', sources: [{ commits: ['abc'] }] }])
      await client.callTool({
        name: 'add_port_doctrine_rule',
        arguments: { number: 5, title: 'Native', body: 'Adapt natively.' },
      })
      await client.callTool({ name: 'retire_port_doctrine_rule', arguments: { number: 5 } })
      const doctrine = await client.callTool({
        name: 'list_port_doctrine',
        arguments: { include_retired: true },
      })
      expect(value(doctrine)).toMatchObject([{ number: 5, retired_at: expect.any(String) }])
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('orch doc subjects --json lists project, agent and job names', async () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    expect(docSubjects()).toEqual({
      project: ['known'],
      stack: [],
      agent: Object.keys(AGENTS).sort(),
      job: Object.keys(JOBS).sort(),
    })
  })

  test('orch doc rm --json reports whether a row was removed', async () => {
    await setDoc({ scope: 'global', subject: null, slug: 'gone', title: 'T', body: 'B' })
    expect(await removeDoc('global', null, 'gone')).toBe(true)
    expect(await removeDoc('global', null, 'gone')).toBe(false)
  })

  test('orch doc set --json round-trips a body with quote, backtick and newline', async () => {
    const body = "quote' backtick` newline\n"
    await setDoc({ scope: 'global', subject: null, slug: 'round-trip', title: 'T', body })
    expect(getDoc('global', null, 'round-trip')?.body).toBe(body)
  })

  test('orch doc history, diff, and restore operate on revisions without rewinding', async () => {
    await writeDoc({
      scope: 'global',
      subject: null,
      slug: 'cli-history',
      title: 'T',
      body: 'one\n',
      delivery: 'demand',
      reason: 'first',
    })
    await writeDoc({
      scope: 'global',
      subject: null,
      slug: 'cli-history',
      title: 'T',
      body: 'two\n',
      delivery: 'demand',
      reason: 'second',
    })
    const rows = listDocRevisions('global', null, 'cli-history')
    const newerId = rows[0]!.id
    const originalId = rows[1]!.id
    expect(rows.map((row) => row.reason)).toEqual(['second', 'first'])
    expect(rows[0]).toMatchObject({
      id: expect.any(Number),
      op: 'set',
      author: expect.any(String),
      reason: 'second',
      at: expect.any(String),
      bytes: 4,
    })
    expect(diffDocRevisions(originalId, newerId)).toContain('-one\n+two')
    await deleteDoc('global', null, 'cli-history', { reason: 'gone' })
    await restoreDoc('global', null, 'cli-history', originalId, { reason: 'undo delete' })
    expect(getDoc('global', null, 'cli-history')?.body).toBe('one\n')
    expect(listDocRevisions('global', null, 'cli-history')[0]?.op).toBe('restore')
  }, 20_000)

  test('orch doc consume stamps the session and preserves the document outside its fields', async () => {
    const body =
      '---\r\nstatus: open\r\nepic: demo\r\nproject: known\r\nwritten: 2026-09-03T00:00:00.000Z\r\n---\r\n\r\nNEXT ACTION  \r\n'
    await setDoc({ scope: 'global', subject: null, slug: 'take-it', title: 'Take it', body })
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = 'consume-test-session'
    try {
      const result = await consumeDoc('global', null, 'take-it')
      expect(result.already_consumed).toBe(false)
      const consumed = getDoc('global', null, 'take-it')!.body
      expect(consumed).toMatch(
        /^---\r\nstatus: consumed\r\nconsumed: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\r\nconsumed_by: consume-test-session\r\nepic:/,
      )
      expect(consumed.slice(consumed.indexOf('epic:'))).toBe(body.slice(body.indexOf('epic:')))
      expect(parseResumeFrontmatter(consumed)).toMatchObject({
        status: 'consumed',
        consumed_by: 'consume-test-session',
      })
    } finally {
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    }
  })

  test('orch doc consume reports an already-consumed document without rewriting it', async () => {
    const body =
      '---\nstatus: consumed\nconsumed: 2026-09-03T01:02:03.000Z\nconsumed_by: first-session\nepic: demo\n---\n\nBODY\n'
    await setDoc({ scope: 'global', subject: null, slug: 'taken', title: 'Taken', body })
    const before = getDoc('global', null, 'taken')!
    expect((await consumeDoc('global', null, 'taken')).already_consumed).toBe(true)
    expect(getDoc('global', null, 'taken')).toEqual(before)
  })
})
