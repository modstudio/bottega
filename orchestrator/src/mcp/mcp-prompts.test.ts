import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { removeProject, upsertProject } from '../project/projects.ts'
import type { WorkflowDefinition } from '../workflow/workflows.ts'
import { createDocsMcpServer } from './mcp.ts'
import { workflowPromptDefinitions } from './mcp-prompts.ts'

const workflow = (
  slug: string,
  arguments_: WorkflowDefinition['arguments'],
): { slug: string; definition: WorkflowDefinition } => ({
  slug,
  definition: {
    title: 'Ship task',
    description: 'Ship one task.',
    arguments: arguments_,
    modes: [
      { slug: 'fast', title: 'Fast', default: true, steps: ['implement'] },
      { slug: 'careful', title: 'Careful', steps: ['plan', 'implement'] },
    ],
  },
})

describe('workflow prompt definitions', () => {
  test('declared-argument and mode-list mutation: retains every argument and mode, naming the required ones', () => {
    const [prompt] = workflowPromptDefinitions([
      workflow('ship-task', [
        { name: 'key', description: 'Task key.', required: true },
        { name: 'note', description: 'Optional note.', required: false },
      ]),
    ])

    expect(prompt?.arguments).toEqual([
      {
        name: 'mode',
        description:
          'Workflow mode slug. One of: fast, careful. Omit to use the default mode, or to be asked which mode to run when the workflow has none.',
      },
      {
        name: 'project',
        description:
          "Registered project name. Omit to use the project that owns the server's working directory.",
      },
      {
        name: 'autonomy',
        description: 'Comma-separated session autonomy key=value overrides.',
      },
      {
        name: 'key',
        description:
          'Task key. Required by the workflow; if omitted, the composition names it as missing.',
      },
      { name: 'note', description: 'Optional note.' },
    ])
  })

  test('prompt-name mutation: uses workflow slugs unchanged', () => {
    expect(workflowPromptDefinitions([workflow('ship-task', [])])[0]?.name).toBe('ship-task')
  })
})

describe('workflow prompts on the wire', () => {
  afterEach(() => {
    removeProject('prompt-fixture')
  })

  const connected = async () => {
    const server = createDocsMcpServer()
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'prompt-test', version: '1' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return client
  }

  test('advertised-requiredness mutation: a workflow-required argument reaches the client optional and described', async () => {
    const client = await connected()
    const { prompts } = await client.listPrompts()
    const key = prompts
      .find((prompt) => prompt.name === 'fix-defect')
      ?.arguments?.find((argument) => argument.name === 'key')

    expect(key?.required).toBe(false)
    expect(key?.description).toContain('Required by the workflow')
  })

  test('blank-argument mutation: blank values count as omitted, so composition asks for the missing argument', async () => {
    upsertProject({
      name: 'prompt-fixture',
      path: process.cwd(),
      stack: 'node',
      settings: { gate: 'true', docs: { protocol: 'orch-docs' } },
    })
    const client = await connected()
    const result = await client.getPrompt({
      name: 'fix-defect',
      arguments: { mode: '', project: '', key: ' ' },
    })

    expect(result.messages[0]?.content).toMatchObject({
      text: expect.stringContaining('- key: The filed task key.'),
    })
  })
})
