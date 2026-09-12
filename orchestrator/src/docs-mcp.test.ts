import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Database } from 'bun:sqlite'
import { beforeEach,describe,expect,spyOn,test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scriptedTransportSequence } from '../test/fake-transport.ts'
import { addRun,createDocsMcpServer,db,dir,docsForRun,getDoc,promoteWorkflow,recordReview,reviewReply,runJob,setDoc,setWorkflow,upsertProject } from '../test/fixture.ts'
import { trackedTestResidue } from '../test/residue.ts'
const trackResidue = trackedTestResidue(); beforeEach(() => { trackResidue(join(dir, '.claude')) })


describe('scoped operator docs', () => {
  test('first-turn bound prompts inject docs and count them; resumes do neither', async () => {
    upsertProject({ name: 'known', path: dir, stack: null, canon: true, settings: {} })
    setDoc({ scope: 'global', subject: null, slug: 'g', title: 'Global', body: 'G' })
    setDoc({ scope: 'job', subject: 'file-question', slug: 'j', title: 'Job', body: 'J' })
    setDoc({ scope: 'project', subject: 'known', slug: 'p', title: 'Project', body: 'P' })
    const transport = scriptedTransportSequence([
      [{ kind: 'completed', output: 'ok' }],
      [{ kind: 'completed', output: 'ok' }],
    ])
    transport.install()
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const first = await runJob({ job: 'file-question', prompt: 'FIRST SPEC', cwd: dir, agent: 'codex' })
      const firstRow = db().query('SELECT prompt_path, docs_injected, doc_revisions, canon_sha FROM run WHERE id=?').get(first.id) as
        { prompt_path: string; docs_injected: number; doc_revisions: string; canon_sha: string }
      const bound = readFileSync(firstRow.prompt_path.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8')
      expect(bound).toContain('WHAT THE OPERATOR WANTS YOU TO KNOW\n\n## Global\n\nG\n\n## Job\n\nJ\n\n## Project\n\nP')
      expect(firstRow.docs_injected).toBe(3)
      expect(JSON.parse(firstRow.doc_revisions)).toEqual(
        docsForRun({ job: 'file-question', cwd: dir }).map((doc) => doc.revision_id),
      )
      expect(firstRow.canon_sha).toHaveLength(64)
      expect(db().query('SELECT sha256,doc_count FROM canon_pack WHERE job=?').get('file-question'))
        .toEqual({ sha256: firstRow.canon_sha, doc_count: 3 })
      db().query('UPDATE run SET vendor_session=? WHERE id=?').run('docs-session', first.id)
      const resumed = await runJob({
        job: 'file-question', prompt: 'RULING', cwd: dir,
        resume: { parent: first.id, agent: 'codex', session: 'docs-session', turn: 2,
          sessionId: 'owner', worktree: null },
      })
      expect(transport.startOptions()[1]?.prompt).not.toContain('WHAT THE OPERATOR WANTS YOU TO KNOW')
      expect(db().query('SELECT docs_injected, doc_revisions FROM run WHERE id=?').get(resumed.id)).toEqual({
        docs_injected: 0, doc_revisions: null,
      })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('MCP list_reviews and get_review round-trip through linked in-memory transports', async () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'mcp-model', lens: 'mcp-review' })
    const reviewId = recordReview(runId, reviewReply(1), db())
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport); await client.connect(clientTransport)
    try {
      const parse = (result: any) => JSON.parse((result.content[0] as { text: string }).text)
      const listed = parse(await client.callTool({ name: 'list_reviews', arguments: { open: true } }))
      const shown = parse(await client.callTool({ name: 'get_review', arguments: { id: reviewId } }))
      expect(listed).toEqual([expect.objectContaining({ id: reviewId, findings: { total: 1, triaged: 0,
        accepted: 0, modified: 0, rejected: 0, skipped: 0 } })])
      expect(shown).toMatchObject({ id: reviewId, lenses: [{ run_id: runId, lens: 'mcp-review' }],
        findings: [{ evidence: 'evidence 1' }] })
    } finally { await client.close(); await server.close() }
  })

  test('MCP re-advertises tools after a migration stamps a new user_version', async () => {
    const server = createDocsMcpServer()
    const advertised: string[] = []
    spyOn(server, 'sendToolListChanged').mockImplementation(() => { advertised.push('changed') })
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport); await client.connect(clientTransport)
    try {
      await client.callTool({ name: 'list_projects', arguments: {} })
      expect(advertised).toEqual([])
      const other = new Database(process.env.ORCH_DB!)
      const current = (other.query('PRAGMA user_version').get() as { user_version: number }).user_version
      other.exec(`PRAGMA user_version = ${current + 1}`)
      other.close()
      await client.callTool({ name: 'list_projects', arguments: {} })
      expect(advertised).toEqual(['changed'])
    } finally { await client.close(); await server.close() }
  })

  test('MCP list_docs and get_doc work through linked in-memory transports', async () => {
    setDoc({ scope: 'global', subject: null, slug: 'mcp', title: 'MCP', body: 'Visible' })
    setDoc({
      scope: 'global', subject: null, slug: 'mcp-consume', title: 'MCP consume',
      body: '---\nstatus: open\n---\n\nVisible\n',
    })
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const listed = await client.callTool({ name: 'list_docs', arguments: { scope: 'global' } })
      const fetched = await client.callTool({ name: 'get_doc', arguments: { scope: 'global', slug: 'mcp' } })
      const consumed = await client.callTool({
        name: 'consume_doc', arguments: { scope: 'global', slug: 'mcp-consume' },
      })
      const missingReason = await client.callTool({
        name: 'set_doc', arguments: { scope: 'global', slug: 'bad', title: 'Bad', body: 'Bad' },
      })
      const set = await client.callTool({
        name: 'set_doc', arguments: {
          scope: 'global', slug: 'mcp-set', title: 'Set', body: '`orch nosuch`',
          delivery: 'demand', reason: 'MCP round trip',
        },
      })
      const setRow = JSON.parse(((set as any).content[0] as { text: string }).text)
      const revisionList = await client.callTool({
        name: 'list_doc_revisions', arguments: { scope: 'global', slug: 'mcp-set' },
      })
      const revisionRows = JSON.parse(((revisionList as any).content[0] as { text: string }).text)
      const revision = await client.callTool({
        name: 'get_doc_revision', arguments: { id: revisionRows[0].id },
      })
      const listedText = ((listed as any).content[0] as { text: string }).text
      const fetchedText = ((fetched as any).content[0] as { text: string }).text
      const consumedText = ((consumed as any).content[0] as { text: string }).text
      const listedRows = JSON.parse(listedText)
      expect(listedRows).toHaveLength(2)
      expect(listedRows[0]).toEqual({
        id: expect.any(Number), scope: 'global', subject: null, slug: 'mcp', title: 'MCP',
        bytes: 7, updated_at: expect.any(String),
      })
      expect(listedRows[0]).not.toHaveProperty('body')
      expect(JSON.parse(fetchedText).body).toBe('Visible')
      expect(JSON.parse(consumedText)).toMatchObject({ already_consumed: false })
      expect(getDoc('global', null, 'mcp-consume')?.body).toContain('status: consumed')
      expect(missingReason.isError).toBe(true)
      expect(((missingReason as any).content[0] as { text: string }).text).toContain('reason')
      expect(setRow.body).toBe('`orch nosuch`')
      expect(setRow.delivery).toBe('demand')
      expect(setRow.warnings[0]).toMatchObject({ kind: 'orch-command' })
      expect(revisionRows[0]).toMatchObject({ op: 'create', author: expect.any(String), reason: 'MCP round trip' })
      expect(JSON.parse(((revision as any).content[0] as { text: string }).text).body).toBe('`orch nosuch`')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('MCP workflow tools return lean indexes, needs, and one substituted step', async () => {
    const definition = {
      title: 'Choose', description: 'MCP fixture',
      arguments: [{ name: 'key', required: true, description: 'Task key' }],
      modes: [{ slug: 'careful', title: 'Careful', entry: 'Use the careful path?', steps: ['inspect'] }],
      steps: [{ slug: 'inspect', title: 'Inspect', job: null, autonomy: 'manual', gate: null, body: 'Inspect {{key}}.' }],
    }
    const draft = setWorkflow('mcp-workflow', definition, 'test MCP', 'test')
    promoteWorkflow('mcp-workflow', draft.n, 'publish MCP fixture', 'test')
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport); await client.connect(clientTransport)
    try {
      const parse = (result: any) => JSON.parse((result.content[0] as {text:string}).text)
      const listed = parse(await client.callTool({ name: 'list_workflows', arguments: {} }))
      const needs = parse(await client.callTool({ name: 'compose_workflow', arguments: { slug: 'mcp-workflow' } }))
      const composed = parse(await client.callTool({ name: 'compose_workflow', arguments: { slug: 'mcp-workflow', mode: 'careful', args: { key: 'DEV-257' } } }))
      const step = parse(await client.callTool({ name: 'get_workflow_step', arguments: { slug: 'mcp-workflow', step: 'inspect', args: { key: 'DEV-257' } } }))
      expect(listed.some((workflow:any)=>workflow.slug==='mcp-workflow')).toBe(true)
      expect(needs.needs).toEqual({ mode: [{ slug:'careful',title:'Careful',entry:'Use the careful path?' }], arguments:['key'] })
      expect(JSON.stringify(composed)).not.toContain('Inspect {{key}}')
      expect(step.body).toBe('Inspect DEV-257.')
    } finally { await client.close(); await server.close() }
  })

  test('MCP file_issue refuses a call missing evidence with an actionable message', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
          kind: 'defect',
          what_happened: 'The command failed',
          expected: 'The command should succeed',
          reproduce_command: 'bun test',
          environment: 'macOS test fixture',
          not_established: 'The underlying cause is not established',
        },
      })
      expect(filed.isError).toBe(true)
      const message = ((filed as any).content[0] as { text: string }).text
      expect(message).toContain('evidence is required')
      expect(message).toContain('run ids, file:line pointers, or measured output')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('MCP note refuses outside a registered project', async () => {
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const filed = await client.callTool({ name: 'note', arguments: { text: 'outside', new: true } })
      expect(filed.isError).toBe(true)
      expect(((filed as any).content[0] as { text: string }).text).toContain('no registered project contains')
    } finally {
      await client.close()
      await server.close()
    }
  })

})
