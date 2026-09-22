import { describe, expect, test } from 'bun:test'
import type { WorkflowDefinition } from '../workflow/workflows.ts'
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
  test('declared-argument and mode-list mutation: retains required arguments and every mode', () => {
    const [prompt] = workflowPromptDefinitions([
      workflow('ship-task', [
        { name: 'key', description: 'Task key.', required: true },
        { name: 'branch', description: 'Branch name.', required: true },
      ]),
    ])

    expect(prompt?.arguments).toEqual([
      {
        name: 'mode',
        description: 'Workflow mode slug. One of: fast, careful. Omit to use the default mode.',
        required: false,
      },
      {
        name: 'project',
        description:
          "Registered project name. Omit to use the project that owns the server's working directory.",
        required: false,
      },
      { name: 'key', description: 'Task key.', required: true },
      { name: 'branch', description: 'Branch name.', required: true },
    ])
  })

  test('requiredness mutation: retains optional declared arguments as optional', () => {
    const [prompt] = workflowPromptDefinitions([
      workflow('ship-task', [{ name: 'note', description: 'Optional note.', required: false }]),
    ])

    expect(prompt?.arguments.find((argument) => argument.name === 'note')).toEqual({
      name: 'note',
      description: 'Optional note.',
      required: false,
    })
  })

  test('prompt-name mutation: uses workflow slugs unchanged', () => {
    expect(workflowPromptDefinitions([workflow('ship-task', [])])[0]?.name).toBe('ship-task')
  })
})
