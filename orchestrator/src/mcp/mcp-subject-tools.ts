// concern: mcp-subject-tools
/** Exposes subject services through MCP without owning subject policy. */
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { SubjectDefinitionSchema } from '../../../shared/subjects.ts'
import {
  addSubject,
  defineSubject,
  listSubjects,
  renameSubject,
  reorderSubjects,
  resolveSubject,
  retireSubject,
} from '../subject/subjects.ts'

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
})
const project = z.string().trim().min(1)
const reference = z
  .string()
  .trim()
  .min(1)
  .describe('Subject UUID or current name within the project.')
const definition = SubjectDefinitionSchema

export function registerSubjectTools(server: McpServer): void {
  server.registerTool(
    'list_subjects',
    {
      description: 'List a project subject catalogue in its explicit order.',
      inputSchema: z.object({ project, include_retired: z.boolean().optional() }),
    },
    async ({ project, include_retired }) =>
      text(listSubjects(project, { retired: include_retired })),
  )
  server.registerTool(
    'add_subject',
    {
      description: 'Append a subject to a project catalogue.',
      inputSchema: z.object({ project, name: z.string().trim().min(1), definition }),
    },
    async (input) => text(await addSubject(input)),
  )
  server.registerTool(
    'rename_subject',
    {
      description: 'Rename a project subject selected by UUID or current name.',
      inputSchema: z.object({ project, subject: reference, name: z.string().trim().min(1) }),
    },
    async ({ project, subject, name }) =>
      text(await renameSubject(project, resolveSubject(project, subject).id, name)),
  )
  server.registerTool(
    'define_subject',
    {
      description: 'Change a project subject one-line definition.',
      inputSchema: z.object({ project, subject: reference, definition }),
    },
    async ({ project, subject, definition }) =>
      text(await defineSubject(project, resolveSubject(project, subject).id, definition)),
  )
  server.registerTool(
    'reorder_subjects',
    {
      description: 'Set the complete order of every non-retired subject in a project.',
      inputSchema: z.object({ project, subjects: z.array(reference) }),
    },
    async ({ project, subjects }) =>
      text(
        await reorderSubjects(
          project,
          subjects.map((subject) => resolveSubject(project, subject).id),
        ),
      ),
  )
  server.registerTool(
    'retire_subject',
    {
      description: 'Retire a project subject without deleting it.',
      inputSchema: z.object({ project, subject: reference }),
    },
    async ({ project, subject }) =>
      text(await retireSubject(project, resolveSubject(project, subject).id)),
  )
}
