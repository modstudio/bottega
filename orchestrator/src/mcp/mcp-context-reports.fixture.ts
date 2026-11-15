import { expect } from 'bun:test'
import type { ContextMomentPorts } from '../doc/context-moment-adapter.ts'
import { createDocsMcpServer } from './mcp.ts'

function recordingContextMomentPorts(
  calls: string[],
  bodies: Map<string, string>,
): ContextMomentPorts {
  return {
    revision: async () => undefined,
    set: async (input) => {
      calls.push(`set ${input.kind} ${input.id} on ${input.task}`)
      bodies.set(input.id, input.body)
      return {
        ...input,
        holder: `task:${input.task}`,
        revision: 'revision',
        task: input.task ?? null,
      }
    },
  }
}

function expectWorkflowRulingContextReports(input: {
  questionId: number
  calls: string[]
  awaited: { content: unknown }
  ruled: { content: unknown }
}): void {
  const { questionId, calls, awaited, ruled } = input
  expect(calls).toEqual([`set ruling ruling-q${questionId} on DEV-1069`])
  expect(awaited.content as { text: string }[]).toHaveLength(1)
  expect((ruled.content as { text: string }[]).slice(1).map(({ text }) => text)).toEqual([
    `context: wrote ruling ruling-q${questionId} on DEV-1069`,
  ])
}

export function workflowRulingContextFixture(
  ports: Parameters<typeof createDocsMcpServer>[0] = {},
) {
  const calls: string[] = []
  const bodies = new Map<string, string>()
  return {
    server: createDocsMcpServer({
      hubTaskReader: async () => [
        { key: 'DEV-1069', record_id: 'task-DEV-1069', project: 'fixture' },
      ],
      ...ports,
      contextMomentPorts: recordingContextMomentPorts(calls, bodies),
    }),
    bodies,
    expectReports: (
      questionId: number,
      awaited: { content: unknown },
      ruled: { content: unknown },
    ) => expectWorkflowRulingContextReports({ questionId, calls, awaited, ruled }),
  }
}
