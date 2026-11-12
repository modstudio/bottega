import { expect } from 'bun:test'
import type { ContextMomentPorts } from '../doc/context-moment-adapter.ts'
import { createDocsMcpServer } from './mcp.ts'

function recordingContextMomentPorts(calls: string[]): ContextMomentPorts {
  return {
    set: async (input) => {
      calls.push(`set ${input.kind} ${input.id} on ${input.task}`)
      return {
        ...input,
        holder: `task:${input.task}`,
        revision: 'revision',
        task: input.task ?? null,
      }
    },
    drop: async (input) => {
      calls.push(`drop ${input.id} on ${input.task}`)
      return { ...input, holder: `task:${input.task}`, task: input.task ?? null, removed: true }
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
  expect(calls).toEqual([
    `set open-question open-q${questionId} on DEV-1069`,
    `set ruling ruling-q${questionId} on DEV-1069`,
    `drop open-q${questionId} on DEV-1069`,
  ])
  expect((awaited.content as { text: string }[])[1]?.text).toBe(
    `context: wrote open-question open-q${questionId} on DEV-1069`,
  )
  expect((ruled.content as { text: string }[]).slice(1).map(({ text }) => text)).toEqual([
    `context: wrote ruling ruling-q${questionId} on DEV-1069`,
    `context: dropped open-question open-q${questionId} on DEV-1069`,
  ])
}

export function workflowRulingContextFixture() {
  const calls: string[] = []
  return {
    server: createDocsMcpServer({
      hubTaskReader: async () => [
        { key: 'DEV-1069', record_id: 'task-DEV-1069', project: 'fixture' },
      ],
      contextMomentPorts: recordingContextMomentPorts(calls),
    }),
    expectReports: (
      questionId: number,
      awaited: { content: unknown },
      ruled: { content: unknown },
    ) => expectWorkflowRulingContextReports({ questionId, calls, awaited, ruled }),
  }
}
