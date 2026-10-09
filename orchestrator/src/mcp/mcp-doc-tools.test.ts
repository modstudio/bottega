import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { setDoc } from '../../test/fixtures/docs.ts'
import { getDoc } from '../doc/docs.ts'
import { projectByName, upsertProject } from '../project/projects.ts'
import { registerDocTools } from './mcp-doc-tools.ts'

const project = 'mcp-canon-write'
const slug = '.agents/rules/mcp-canon-write.md'
const initialBody = '---\ndescription: MCP canon write fixture\n---\n\n# Initial rule\n'
const selectedTree = '/fixture/canon-tree'
const canonFacts = {
  trackedPaths: [slug, 'orchestrator/src/mcp/supplied.ts'],
  packageScripts: [],
  sourceTexts: [],
}

function smallCanonTree() {
  return { project: projectByName(project)!, root: selectedTree }
}

const collectCanonLintInput = () => canonFacts

async function withDocClient(run: (client: Client) => Promise<void>): Promise<void> {
  const server = new McpServer({ name: 'orch-doc-test', version: '1.0.0' })
  registerDocTools(server, { selectCanonWriteTree: smallCanonTree, collectCanonLintInput })
  const client = new Client({ name: 'orch-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

async function canonFixture() {
  upsertProject({ name: project, path: selectedTree, canon: true, settings: {} })
  return setDoc({
    scope: 'canon',
    subject: project,
    slug,
    title: 'MCP canon write',
    body: initialBody,
    allowCanonBootstrap: true,
    canonTree: smallCanonTree(),
    collectCanonLintInput,
  })
}

test('set_doc stores the next revision against the selected canon tree', async () => {
  const current = await canonFixture()
  const body = `${initialBody}\nThe current rule cites \`orchestrator/src/mcp/supplied.ts\`.\n`

  await withDocClient(async (client) => {
    const result = await client.callTool({
      name: 'set_doc',
      arguments: {
        scope: 'canon',
        subject: project,
        slug,
        title: 'MCP canon write',
        body,
        reason: 'exercise the MCP canon set path',
        expected_revision: current.revision,
        cwd: process.cwd(),
      },
    })

    expect(result.isError).not.toBe(true)
    const written = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      revision: string
    }
    expect(written).toMatchObject({
      body,
      tree: selectedTree,
    })
    expect(written.revision).not.toBe(current.revision)
    expect(getDoc('canon', project, slug)).toMatchObject({ body, revision: written.revision })
  })
})

test('set_doc refuses an existing canon row without expected_revision', async () => {
  const current = await canonFixture()

  await withDocClient(async (client) => {
    const result = await client.callTool({
      name: 'set_doc',
      arguments: {
        scope: 'canon',
        subject: project,
        slug,
        title: 'MCP canon write',
        body: `${initialBody}\nChanged without a revision.\n`,
        reason: 'exercise the missing revision refusal',
        cwd: process.cwd(),
      },
    })

    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).toContain(
      `current revision ${current.revision}; pass expected_revision ${current.revision}; ` +
        're-read with get_doc and re-apply the edit',
    )
  })
})

test('set_doc reports a stale canon revision with the MCP remedy', async () => {
  const current = await canonFixture()

  await withDocClient(async (client) => {
    const result = await client.callTool({
      name: 'set_doc',
      arguments: {
        scope: 'canon',
        subject: project,
        slug,
        title: 'MCP canon write',
        body: `${initialBody}\nChanged with a stale revision.\n`,
        reason: 'exercise the stale revision refusal',
        expected_revision: 'stale-revision',
        cwd: process.cwd(),
      },
    })

    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).toContain(
      `current revision ${current.revision}; pass expected_revision ${current.revision}; ` +
        're-read with get_doc and re-apply the edit',
    )
  })
})

test('remove_doc removes at the expected revision against the selected canon tree', async () => {
  const current = await canonFixture()

  await withDocClient(async (client) => {
    const result = await client.callTool({
      name: 'remove_doc',
      arguments: {
        scope: 'canon',
        subject: project,
        slug,
        reason: 'exercise the MCP canon removal path',
        expected_revision: current.revision,
        cwd: process.cwd(),
      },
    })

    expect(result.isError).not.toBe(true)
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({
      removed: true,
      tree: selectedTree,
    })
  })
})

test('remove_doc refuses an existing canon row without expected_revision', async () => {
  const current = await canonFixture()

  await withDocClient(async (client) => {
    const result = await client.callTool({
      name: 'remove_doc',
      arguments: {
        scope: 'canon',
        subject: project,
        slug,
        reason: 'exercise the missing revision refusal',
        cwd: process.cwd(),
      },
    })

    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).toContain(
      `current revision ${current.revision}; pass expected_revision ${current.revision}; ` +
        're-read with get_doc and re-apply the edit',
    )
  })
})
