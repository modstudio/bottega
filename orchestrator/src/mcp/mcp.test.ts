import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
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
  test('worker-facing workflow tools refuse a session release override', async () => {
    const project = 'mcp-release-autonomy'
    upsertProject({
      name: project,
      path: '/mcp-release-autonomy',
      stack: 'bun',
      settings: {
        gate: 'bun run check',
        trunk: 'main',
        docs: { protocol: 'orch-docs' },
        tracker: { kind: 'hub', protocol: 'hub' },
        autonomy: { release: 'push' },
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
          arguments: { slug: 'ship', project, mode: 'default', autonomy: 'release=promote' },
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
          'use orch config set autonomy.release <value>',
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
