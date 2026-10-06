import { describe, expect, test } from 'bun:test'
import {
  Client,
  InMemoryTransport,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from '@modelcontextprotocol/client'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import {
  installRecordSessionRunner,
  memoryRecordSession,
} from '../../test/fixtures/record-session.ts'
import { db } from '../database/db.ts'
import { missingIssueReportFields } from '../issue/issue-report-fields.ts'
import { removeProject, upsertProject } from '../project/projects.ts'
import { productionStepCatalogue } from '../workflow/step-catalogue.ts'
import { promoteWorkflow, setWorkflow } from '../workflow/workflows.ts'
import { createDocsMcpServer } from './mcp.ts'

describe('orch MCP', () => {
  test('workflow ruling tools return the durable question id', async () => {
    db()
      .query(
        `INSERT INTO workflow_cursor
        (project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
         workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
         total_steps,created_at,updated_at,enforcement)
       VALUES ('fixture','ship','default','DEV-1069','',NULL,1,1,'{"key":"DEV-1069"}',
               0,'rebase','running','[]',NULL,1,'2026-10-01','2026-10-01','floors')`,
      )
      .run()
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const awaited = await client.callTool({
        name: 'await_workflow_ruling',
        arguments: {
          slug: 'ship',
          project: 'fixture',
          mode: 'default',
          args: { key: 'DEV-1069' },
          question: 'Proceed?',
        },
      })
      const awaitResult = JSON.parse((awaited.content as { text: string }[])[0]!.text) as {
        questionId: number
      }
      const ruled = await client.callTool({
        name: 'rule_workflow',
        arguments: {
          slug: 'ship',
          project: 'fixture',
          mode: 'default',
          args: { key: 'DEV-1069' },
          ruling: 'Proceed.',
          from_operator: true,
        },
      })
      expect(awaitResult.questionId).toBeGreaterThan(0)
      expect(JSON.parse((ruled.content as { text: string }[])[0]!.text)).toMatchObject({
        questionId: awaitResult.questionId,
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('serves the same tools to legacy initialize and a pinned 2026 client', async () => {
    const [legacyClientTransport, legacyServerTransport] = InMemoryTransport.createLinkedPair()
    const legacyServer = serveStdio(createDocsMcpServer, { transport: legacyServerTransport })
    await legacyClientTransport.start()

    let requestId = 0
    const legacyRequest = <T>(method: string, params?: Record<string, unknown>) => {
      const id = ++requestId
      return new Promise<T>((resolve, reject) => {
        legacyClientTransport.onmessage = (message: JSONRPCMessage) => {
          if (!('id' in message) || message.id !== id) return
          if ('error' in message) reject(new Error(message.error.message))
          else if ('result' in message) resolve(message.result as T)
        }
        const request: JSONRPCRequest = {
          jsonrpc: '2.0',
          id,
          method,
          ...(params ? { params } : {}),
        }
        legacyClientTransport.send(request).catch(reject)
      })
    }

    try {
      const initialized = await legacyRequest<{ protocolVersion: string }>('initialize', {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'orch-legacy-test', version: '1.0.0' },
      })
      expect(initialized.protocolVersion).toBe('2025-11-25')
      await legacyClientTransport.send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      })
      const legacyTools = await legacyRequest<{ tools: { name: string }[] }>('tools/list')

      const modernClient = new Client(
        { name: 'orch-modern-test', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      )
      const [modernClientTransport, modernServerTransport] = InMemoryTransport.createLinkedPair()
      const modernServer = serveStdio(createDocsMcpServer, { transport: modernServerTransport })
      await modernClient.connect(modernClientTransport)
      try {
        const modernTools = await modernClient.listTools()
        expect(modernTools.tools.map(({ name }) => name).sort()).toEqual(
          legacyTools.tools.map(({ name }) => name).sort(),
        )
      } finally {
        await modernClient.close()
        await modernServer.close()
      }
    } finally {
      await legacyClientTransport.close()
      await legacyServer.close()
    }
  })

  test('worker-facing workflow tools refuse session ship-to names', async () => {
    const project = 'mcp-ship-to'
    upsertProject({
      name: project,
      path: '/mcp-ship-to',
      stack: 'bun',
      settings: {
        gate: 'bun run check',
        trunk: 'main',
        docs: { protocol: 'orch-docs' },
        tracker: { kind: 'hub', protocol: 'hub' },
        autonomy: { shipTo: 'branch' },
      },
    })
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      for (const request of [
        {
          name: 'compose_workflow',
          arguments: { slug: 'ship', project, mode: 'default', autonomy: 'ship-to=production' },
        },
        {
          name: 'get_workflow_step',
          arguments: {
            slug: 'ship',
            project,
            step: 'rebase',
            mode: 'default',
            autonomy: 'release=promote',
          },
        },
      ]) {
        const result = await client.callTool(request)
        expect(result.isError).toBe(true)
        expect((result.content as { text: string }[])[0]!.text).toContain(
          'use orch config set autonomy.ship-to <value>',
        )
      }
    } finally {
      await client.close()
      await server.close()
      removeProject(project)
    }
  })

  test('next_workflow_step names the MCP mode remedy when no default exists', async () => {
    const slug = 'mcp-no-default-mode'
    const step = productionStepCatalogue().definition.steps[0]!
    const draft = setWorkflow(
      slug,
      {
        title: 'MCP mode refusal',
        description: 'Exercises MCP cursor mode resolution.',
        arguments: [],
        modes: [
          { slug: 'report', title: 'Report', entry: 'Prepare a report?', steps: [step.slug] },
          { slug: 'repair', title: 'Repair', entry: 'Make a repair?', steps: [step.slug] },
        ],
      },
      'test MCP cursor mode resolution',
      'test',
    )
    promoteWorkflow(slug, draft.n, 'publish', 'test')
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({
        name: 'next_workflow_step',
        arguments: {
          slug,
          project: 'irrelevant-before-mode-refusal',
          note: 'completed the report',
        },
      })
      expect(result.isError).toBe(true)
      expect((result.content as { text: string }[])[0]!.text).toContain(
        `next_workflow_step cannot resolve a default mode for workflow "${slug}"; ` +
          'modes: report, repair; pass the mode argument',
      )
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('workflow operation tools expose cursor handles and abandonment parity', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const tools = (await client.listTools()).tools
      for (const name of [
        'get_workflow_step',
        'next_workflow_step',
        'await_workflow_ruling',
        'rule_workflow',
      ]) {
        expect(tools.find((tool) => tool.name === name)?.inputSchema.properties).toHaveProperty(
          'cursor',
        )
      }
      expect(tools.find((tool) => tool.name === 'abandon_workflow')?.inputSchema.required).toEqual(
        expect.arrayContaining(['cursor', 'reason']),
      )
      expect(
        tools.find((tool) => tool.name === 'attach_workflow_text')?.inputSchema.required,
      ).toEqual(expect.arrayContaining(['cursor', 'text']))
      expect(tools.find((tool) => tool.name === 'compose_workflow')?.description).toContain(
        'without opening a run',
      )
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('every MCP workflow operation routes by cursor handle', async () => {
    const project = 'mcp-cursor-handles'
    upsertProject({
      name: project,
      path: '/mcp-cursor-handles',
      stack: 'bun',
      settings: {
        gate: 'bun run check',
        trunk: 'main',
        docs: { protocol: 'orch-docs' },
        tracker: { kind: 'hub', protocol: 'hub' },
      },
    })
    const args = (key: string) => ({ key, branch: `${key}-work`, worktree: `/tmp/${key}` })
    const insert = db().prepare(
      `INSERT INTO workflow_cursor
        (project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
         workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
         total_steps,created_at,updated_at,enforcement)
       VALUES (?,'ship','default',?,'',NULL,1,1,?,0,'rebase','running','[]',NULL,
               3,'2026-10-01','2026-10-01','note-only') RETURNING id`,
    )
    const first = insert.get(project, 'DEV-1082-MCP-A', JSON.stringify(args('DEV-1082-MCP-A'))) as {
      id: number
    }
    const second = insert.get(
      project,
      'DEV-1082-MCP-B',
      JSON.stringify(args('DEV-1082-MCP-B')),
    ) as {
      id: number
    }
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: arguments_ })
      if (result.isError)
        throw new Error(
          `${name}: ${(result.content as { text: string }[])[0]?.text ?? 'unknown error'}`,
        )
      return (result.content as { text: string }[])[0]!.text
    }
    try {
      const common = { slug: 'ship', project, mode: 'default' }
      expect(
        await call('get_workflow_step', {
          ...common,
          step: 'rebase',
          args: args('DEV-1082-MCP-A'),
          cursor: first.id,
        }),
      ).toContain(`cursor ${first.id}`)
      await call('next_workflow_step', {
        ...common,
        args: args('DEV-1082-MCP-A'),
        cursor: first.id,
        note: 'closed through MCP handle',
      })
      await call('await_workflow_ruling', {
        ...common,
        args: args('DEV-1082-MCP-B'),
        cursor: second.id,
        question: 'Proceed through MCP handle?',
      })
      await call('rule_workflow', {
        ...common,
        args: args('DEV-1082-MCP-B'),
        cursor: second.id,
        ruling: 'Proceed.',
        from_operator: true,
      })
      await call('abandon_workflow', { cursor: second.id, reason: 'stopped through MCP handle' })

      expect(
        db().query('SELECT ordinal,state FROM workflow_cursor WHERE id=?').get(first.id),
      ).toEqual({ ordinal: 1, state: 'running' })
      expect(db().query('SELECT state FROM workflow_cursor WHERE id=?').get(second.id)).toEqual({
        state: 'abandoned',
      })
    } finally {
      await client.close()
      await server.close()
      removeProject(project)
    }
  })

  test('file_issue advertises every accepted input field', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const fileIssue = (await client.listTools()).tools.find((tool) => tool.name === 'file_issue')
      expect(Object.keys(fileIssue?.inputSchema.properties ?? {}).sort()).toEqual([
        'affected_project',
        'environment',
        'evidence',
        'expected',
        'kind',
        'monitor_invocation_id',
        'not_established',
        'reporter_kind',
        'reporting_project',
        'reproduce_command',
        'title',
        'what_happened',
      ])
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('file_issue refuses a defect missing reproduce_command', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'defect',
          what_happened: 'The command failed',
          expected: 'The command succeeds',
          environment: 'macOS test fixture',
          evidence: 'run 123 failed with exit 1',
          not_established: 'The underlying cause is not established',
        },
      })
      expect(result.isError).toBe(true)
      expect((result.content as { text: string }[])[0]!.text).toContain(
        'reproduce_command is required: provide the exact command that reproduces or demonstrates the issue',
      )
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('kind-dependent fields have exact missing sets', () => {
    const completeSuggestion = {
      kind: 'suggestion' as const,
      what_happened: 'Expose more filing guidance',
      expected: 'Clients can construct a report without validation retries',
      evidence: 'The advertised schema contains the common report fields',
      not_established: 'Whether clients render every description',
    }
    expect(missingIssueReportFields({ kind: 'defect' })).toEqual([
      'reproduce_command',
      'environment',
    ])
    expect(
      missingIssueReportFields({ kind: 'defect', reproduce_command: 'bun run check' }),
    ).toEqual(['environment'])
    expect(missingIssueReportFields(completeSuggestion)).toEqual([])
  })

  test('get_doc_revision resolves user canon only when user is true', async () => {
    const owner = '01990000-0000-7000-8000-000000000001'
    const revision = db()
      .query<{ id: number }, [string]>(
        `INSERT INTO doc_revision
          (doc_id,scope,subject,owner,slug,op,title,body,delivery,author,reason,at)
         VALUES (1,'canon',NULL,?1,'.agents/rules/private.md','create','Private','body',
           'demand','operator','mcp owner proof','2026-01-01')
         RETURNING id`,
      )
      .get(owner)!
    const session = memoryRecordSession()
    const priorApiUrl = process.env.ORCH_RECORD_API_URL
    process.env.ORCH_RECORD_API_URL = 'https://record-api.example.test'
    session.setToken('fixture-session')
    installRecordSessionRunner(session.runner)
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const ordinary = await client.callTool({
        name: 'get_doc_revision',
        arguments: { id: revision.id },
      })
      expect(ordinary.isError).toBe(true)

      const owned = await client.callTool({
        name: 'get_doc_revision',
        arguments: { id: revision.id, user: true },
      })
      expect(owned.isError).not.toBe(true)
      expect(JSON.parse((owned.content as { text: string }[])[0]!.text)).toMatchObject({
        id: revision.id,
        owner,
      })
    } finally {
      await client.close()
      await server.close()
      installRecordSessionRunner(null)
      if (priorApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
      else process.env.ORCH_RECORD_API_URL = priorApiUrl
    }
  })
})
