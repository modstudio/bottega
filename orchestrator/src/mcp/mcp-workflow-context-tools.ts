// concern: mcp
/** Registers workflow ruling tools and applies their task context effects. */
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { assertRecordShape } from '../../../shared/record-shape.ts'
import type { ContextMomentPorts } from '../doc/context-moment-adapter.ts'
import { workflowQuestionContextMoment } from '../workflow/workflow-context-moment.ts'
import { awaitWorkflowRuling } from '../workflow/workflow-cursor.ts'
import { ruleWorkflow } from '../workflow/workflow-cursor-ruling.ts'
import type { HubTaskReader } from '../workflow/workflow-task-reference.ts'
import { collectContextMomentReports, resultWithContextReports } from './mcp-context-reports.ts'
import { resolveMcpLinkedWorkflowCursor } from './mcp-workflow-cursor.ts'

export type McpWorkflowContextPorts = {
  hubTaskReader?: HubTaskReader
  contextMomentPorts?: ContextMomentPorts
}

function registerAwaitWorkflowRulingTool(server: McpServer, ports: McpWorkflowContextPorts): void {
  server.registerTool(
    'await_workflow_ruling',
    {
      description: 'Record that the workflow is paused on a question for the operator.',
      inputSchema: z.object({
        slug: z.string().trim().min(1),
        project: z.string().trim().min(1),
        mode: z.string().trim().min(1).optional(),
        args: z.record(z.string(), z.string()).optional(),
        question: z.string().trim().min(1),
        cursor: z.number().int().positive().optional(),
      }),
    },
    async ({ slug, project, mode, args, question, cursor }) => {
      const shapedQuestion = assertRecordShape('open question', question)
      const { context, effectiveMode } = await resolveMcpLinkedWorkflowCursor(
        slug,
        project,
        mode,
        args ?? {},
        cursor,
        'await_workflow_ruling',
        'pass the mode argument',
        ports.hubTaskReader,
      )
      const result = await awaitWorkflowRuling(
        slug,
        project,
        effectiveMode,
        args ?? {},
        shapedQuestion,
        context,
        undefined,
        undefined,
        cursor,
      )
      return resultWithContextReports(
        result,
        await collectContextMomentReports(
          workflowQuestionContextMoment({
            moment: 'workflow-await',
            taskKey: context.workflowKey,
            questionId: result.questionId,
            text: shapedQuestion,
          }),
          ports.contextMomentPorts,
        ),
      )
    },
  )
}

function registerRuleWorkflowTool(server: McpServer, ports: McpWorkflowContextPorts): void {
  server.registerTool(
    'rule_workflow',
    {
      description: 'Record a ruling and resume the workflow on the same step.',
      inputSchema: z.object({
        slug: z.string().trim().min(1),
        project: z.string().trim().min(1),
        mode: z.string().trim().min(1).optional(),
        args: z.record(z.string(), z.string()).optional(),
        ruling: z.string().trim().min(1),
        from_operator: z.boolean().optional(),
        cursor: z.number().int().positive().optional(),
      }),
    },
    async ({ slug, project, mode, args, ruling, from_operator, cursor }) => {
      const shapedRuling = assertRecordShape('ruling', ruling)
      const { context, effectiveMode } = await resolveMcpLinkedWorkflowCursor(
        slug,
        project,
        mode,
        args ?? {},
        cursor,
        'rule_workflow',
        'pass the mode argument',
        ports.hubTaskReader,
      )
      const result = await ruleWorkflow(
        slug,
        project,
        effectiveMode,
        args ?? {},
        shapedRuling,
        Boolean(from_operator),
        'mcp',
        context,
        undefined,
        cursor,
      )
      return resultWithContextReports(
        result,
        await collectContextMomentReports(
          workflowQuestionContextMoment({
            moment: 'workflow-rule',
            taskKey: context.workflowKey,
            questionId: result.questionId,
            operatorRuled: Boolean(from_operator),
            text: shapedRuling,
          }),
          ports.contextMomentPorts,
        ),
      )
    },
  )
}

export function registerWorkflowContextTools(
  server: McpServer,
  ports: McpWorkflowContextPorts,
): void {
  registerAwaitWorkflowRulingTool(server, ports)
  registerRuleWorkflowTool(server, ports)
}
