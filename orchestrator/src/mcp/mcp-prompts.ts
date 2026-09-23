import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { projectAt } from '../project/projects.ts'
import { catalogueStepsForAutonomy, parseAutonomy } from '../workflow/autonomy.ts'
import { resolveProjectAutonomy } from '../workflow/autonomy-scopes.ts'
import { composeWorkflowWithCursor, mcpWorkflowCursorContext } from '../workflow/workflow-cursor.ts'
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
  arguments: { name: string; description: string }[]
}

// A client refuses a prompt whose advertised argument is missing before the
// server sees it, so every argument is advertised as optional and composition
// names the workflow-required ones it did not receive.
const requiredNote = ' Required by the workflow; if omitted, the composition names it as missing.'

export function workflowPromptDefinitions(
  workflows: ProductionWorkflow[],
): WorkflowPromptDefinition[] {
  return workflows.map(({ slug, definition }) => ({
    name: slug,
    title: definition.title,
    description: definition.description,
    arguments: [
      {
        name: 'mode',
        description: `Workflow mode slug. One of: ${definition.modes.map((mode) => mode.slug).join(', ')}. Omit to use the default mode, or to be asked which mode to run when the workflow has none.`,
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
      ...definition.arguments.map(({ name, description, required }) => ({
        name,
        description: required ? description + requiredNote : description,
      })),
    ],
  }))
}

const promptMessage = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
})

const promptArgsSchema = (prompt: WorkflowPromptDefinition) =>
  Object.fromEntries(
    prompt.arguments.map((argument) => [
      argument.name,
      z.string().optional().describe(argument.description),
    ]),
  )

export function registerWorkflowPrompts(server: McpServer): void {
  for (const prompt of workflowPromptDefinitions(productionWorkflows())) {
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: promptArgsSchema(prompt),
      },
      async (input) => {
        // A client may send an unfilled argument as a blank string; it counts as omitted.
        const { mode, project, autonomy, ...args } = Object.fromEntries(
          Object.entries(input as Record<string, string | undefined>).filter(
            (entry): entry is [string, string] => Boolean(entry[1]?.trim()),
          ),
        )
        const projectName = project ?? projectAt(process.cwd())?.name
        if (!projectName) {
          return promptMessage(`no registered project contains ${process.cwd()}`)
        }
        try {
          const preliminary = composeWorkflow(prompt.name, projectName, mode, args)
          const resolved = await resolveProjectAutonomy(
            projectName,
            catalogueStepsForAutonomy(preliminary.steps),
            parseAutonomy(autonomy, 'session'),
          )
          return promptMessage(
            renderWorkflowComposition(
              composeWorkflowWithCursor(
                prompt.name,
                projectName,
                mode,
                args,
                mcpWorkflowCursorContext(),
                undefined,
                {},
                resolved,
              ),
            ),
          )
        } catch (error) {
          return promptMessage(error instanceof Error ? error.message : String(error))
        }
      },
    )
  }
}
