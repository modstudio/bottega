import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { projectAt } from '../project/projects.ts'
import { renderWorkflowComposition } from '../workflow/workflow-render.ts'
import {
  composeWorkflow,
  productionWorkflows,
  type WorkflowDefinition,
} from '../workflow/workflows.ts'

type ProductionWorkflow = { slug: string; definition: WorkflowDefinition }

export type WorkflowPromptDefinition = {
  name: string
  title: string
  description: string
  arguments: { name: string; description: string; required: boolean }[]
}

export function workflowPromptDefinitions(
  workflows: ProductionWorkflow[],
): WorkflowPromptDefinition[] {
  return workflows.map(({ slug, definition }) => ({
    name: slug,
    title: definition.title,
    description: definition.description,
    arguments: [
      ...definition.arguments,
      {
        name: 'mode',
        description: `Workflow mode slug. One of: ${definition.modes.map((mode) => mode.slug).join(', ')}. Omit to use the default mode.`,
        required: false,
      },
      {
        name: 'project',
        description:
          "Registered project name. Omit to use the project that owns the server's working directory.",
        required: false,
      },
    ],
  }))
}

const promptMessage = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
})

export function registerWorkflowPrompts(server: McpServer): void {
  for (const prompt of workflowPromptDefinitions(productionWorkflows())) {
    const argsSchema = Object.fromEntries(
      prompt.arguments.map((argument) => {
        const schema = z.string().describe(argument.description)
        return [argument.name, argument.required ? schema.catch('') : schema.optional()]
      }),
    )
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema },
      (input) => {
        const { mode, project, ...values } = input as Record<string, string | undefined>
        const args = Object.fromEntries(
          Object.entries(values).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        )
        const projectName = project ?? projectAt(process.cwd())?.name
        if (!projectName) {
          return promptMessage(`no registered project contains ${process.cwd()}`)
        }
        try {
          return promptMessage(
            renderWorkflowComposition(composeWorkflow(prompt.name, projectName, mode, args)),
          )
        } catch (error) {
          return promptMessage(error instanceof Error ? error.message : String(error))
        }
      },
    )
  }
}
