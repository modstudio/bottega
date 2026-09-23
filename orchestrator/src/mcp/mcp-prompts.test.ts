import { describe, expect, test } from 'bun:test'
import { isSchemaOptional } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { WorkflowDefinition } from '../workflow/workflows.ts'
import { promptArgsSchema, workflowPromptDefinitions } from './mcp-prompts.ts'

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
        description: 'Workflow mode slug. One of: fast, careful. Omit to use the default mode.',
      },
      {
        name: 'project',
        description:
          "Registered project name. Omit to use the project that owns the server's working directory.",
      },
      {
        name: 'key',
        description:
          'Task key. Required by the workflow; if omitted, the composition names it as missing.',
      },
      { name: 'note', description: 'Optional note.' },
    ])
  })

  test('advertised-requiredness mutation: a workflow-required argument is still optional to the client', () => {
    const [prompt] = workflowPromptDefinitions([
      workflow('ship-task', [{ name: 'key', description: 'Task key.', required: true }]),
    ])

    for (const schema of Object.values(promptArgsSchema(prompt!)))
      expect(isSchemaOptional(schema)).toBe(true)
  })

  test('prompt-name mutation: uses workflow slugs unchanged', () => {
    expect(workflowPromptDefinitions([workflow('ship-task', [])])[0]?.name).toBe('ship-task')
  })
})
