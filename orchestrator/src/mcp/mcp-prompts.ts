import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { projectAt, projectByName } from '../project/projects.ts'
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

type BoundWorkflowPromptArguments = {
  mode?: string
  project?: string
  autonomy?: string
  args: Record<string, string>
  reread: string[]
}

function bindingRefusal(definition: WorkflowDefinition, token: string): string {
  const modes = definition.modes.map((mode) => mode.slug)
  const arguments_ = definition.arguments.map((argument) => argument.name)
  const examples = [
    `mode=${token}`,
    `project=${token}`,
    ...arguments_.map((name) => `${name}=${token}`),
  ]
  return `Could not place prompt token "${token}". Workflow modes: ${modes.join(', ')}. Declared arguments: ${arguments_.join(', ') || '(none)'}. Use a named value such as ${examples.join(', ')}.`
}

type PromptSlot = 'mode' | 'project' | 'autonomy'

function promptAssignment(token: string, slot: PromptSlot, argumentNames: Set<string>) {
  const separator = token.indexOf('=')
  if (separator < 1) return null
  const name = token.slice(0, separator)
  const value = token.slice(separator + 1)
  if (argumentNames.has(name)) return { name, value }
  if (slot !== 'autonomy' && (name === 'mode' || name === 'project')) return { name, value }
  return null
}

function placeWorkflowPromptToken(
  definition: WorkflowDefinition,
  bound: BoundWorkflowPromptArguments,
  token: string,
  slot: PromptSlot,
  modeNames: Set<string>,
  argumentNames: Set<string>,
  isProject: (name: string) => boolean,
): string | null {
  const named = promptAssignment(token, slot, argumentNames)
  let name: string
  let value: string
  if (named) {
    ;({ name, value } = named)
  } else if (!bound.mode && modeNames.has(token)) {
    name = 'mode'
    value = token
  } else if (!bound.project && isProject(token)) {
    name = 'project'
    value = token
  } else {
    const argument = definition.arguments.find(
      ({ name: candidate }) => bound.args[candidate] === undefined,
    )
    if (!argument) return bindingRefusal(definition, token)
    name = argument.name
    value = token
  }
  const current = name === 'mode' || name === 'project' ? bound[name] : bound.args[name]
  if (current !== undefined && current !== value) return bindingRefusal(definition, token)
  if (name === 'mode' || name === 'project') bound[name] = value
  else bound.args[name] = value
  bound.reread.push(`read "${token}" as ${name}`)
  return null
}

function bindPromptSlot(
  definition: WorkflowDefinition,
  bound: BoundWorkflowPromptArguments,
  received: Record<string, string>,
  slot: PromptSlot,
  modeNames: Set<string>,
  argumentNames: Set<string>,
  isProject: (name: string) => boolean,
): string | null {
  const token = received[slot]
  if (!token) return null
  if (slot === 'mode' && bound.mode === token) return null
  if (slot === 'project' && bound.project === token) return null
  // An autonomy override is always key=value, so a bare token there is a misplaced one.
  if (slot === 'autonomy' && token.includes('=') && !promptAssignment(token, slot, argumentNames)) {
    bound.autonomy = token
    return null
  }
  return placeWorkflowPromptToken(
    definition,
    bound,
    token,
    slot,
    modeNames,
    argumentNames,
    isProject,
  )
}

export function bindWorkflowPromptArguments(
  definition: WorkflowDefinition,
  received: Record<string, string>,
  isProject: (name: string) => boolean,
): BoundWorkflowPromptArguments | { refusal: string } {
  const modeNames = new Set(definition.modes.map((mode) => mode.slug))
  const argumentNames = new Set(definition.arguments.map((argument) => argument.name))
  const args = Object.fromEntries(
    definition.arguments.flatMap(({ name }) =>
      received[name] === undefined ? [] : [[name, received[name]!]],
    ),
  )
  const bound: BoundWorkflowPromptArguments = { args, reread: [] }
  if (received.mode && modeNames.has(received.mode)) bound.mode = received.mode
  if (received.project && isProject(received.project)) bound.project = received.project

  for (const slot of ['mode', 'project', 'autonomy'] as const) {
    const refusal = bindPromptSlot(
      definition,
      bound,
      received,
      slot,
      modeNames,
      argumentNames,
      isProject,
    )
    if (refusal) return { refusal }
  }
  return bound
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
  for (const workflow of productionWorkflows()) {
    const prompt = workflowPromptDefinitions([workflow])[0]!
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: z.object(promptArgsSchema(prompt)),
      },
      async (input) => {
        // A client may send an unfilled argument as a blank string; it counts as omitted.
        const received = Object.fromEntries(
          Object.entries(input as Record<string, string | undefined>).filter(
            (entry): entry is [string, string] => Boolean(entry[1]?.trim()),
          ),
        )
        const binding = bindWorkflowPromptArguments(workflow.definition, received, (name) =>
          Boolean(projectByName(name)),
        )
        if ('refusal' in binding) return promptMessage(binding.refusal)
        const { mode, project, autonomy, args, reread } = binding
        const projectName = project ?? projectAt(process.cwd())?.name
        if (!projectName) {
          return promptMessage(`no registered project contains ${process.cwd()}`)
        }
        try {
          const preliminary = composeWorkflow(prompt.name, projectName, mode, args)
          const resolved = await resolveProjectAutonomy(
            projectName,
            preliminary.workflow.slug,
            preliminary.workflow.defaultPreset,
            catalogueStepsForAutonomy(preliminary.steps),
            parseAutonomy(autonomy, 'session'),
          )
          return promptMessage(
            [
              ...reread,
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
            ].join('\n'),
          )
        } catch (error) {
          return promptMessage(error instanceof Error ? error.message : String(error))
        }
      },
    )
  }
}
