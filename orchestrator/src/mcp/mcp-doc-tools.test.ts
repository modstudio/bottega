import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { gitToplevel } from '../../../shared/git.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { registerDocTools } from './mcp-doc-tools.ts'

const project = 'mcp-canon-write'
const slug = '.agents/rules/mcp-canon-write.md'
const initialBody = '---\ndescription: MCP canon write fixture\n---\n\n# Initial rule\n'
const selectedTree = gitToplevel(process.cwd())!

async function withDocClient(run: (client: Client) => Promise<void>): Promise<void> {
  const server = new McpServer({ name: 'orch-doc-test', version: '1.0.0' })
  registerDocTools(server)
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
  upsertProject({ name: project, path: process.cwd(), canon: true, settings: {} })
  return setDoc({
    scope: 'canon',
    subject: project,
    slug,
    title: 'MCP canon write',
    body: initialBody,
    allowCanonBootstrap: true,
  })
}

test('set_doc passes the expected revision and selected canon tree to setDoc', async () => {
  const current = await canonFixture()
  const body = `${initialBody}\nThe current rule applies.\n`

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
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
      body,
      tree: selectedTree,
    })
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

test('remove_doc passes the expected revision and selected canon tree to removeDoc', async () => {
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
