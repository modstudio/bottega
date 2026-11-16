// concern: run dispatch prompt assembly
/** Selects the initial or resumed prompt shape after dispatch context is prepared. */

import { initialDispatchPrompt } from './run-pack-prompt.ts'
import { packedResumePrompt } from './run-resume-prompt.ts'

export function runDispatchPrompt(input: {
  job: string
  originalPrompt: string
  resumeParent: string | null
  writesJob: boolean
  preamble: string
  infrastructure: string
  operatorKnowledge: string
  taskRulings: string
  taskText: string
  carriedAttachments: string
}): string {
  if (input.resumeParent) {
    return packedResumePrompt(
      input.job,
      input.originalPrompt,
      input.resumeParent,
      input.carriedAttachments,
    )
  }
  return initialDispatchPrompt({
    writesJob: input.writesJob,
    preamble: input.preamble,
    infrastructure: input.infrastructure,
    operatorKnowledge: input.operatorKnowledge,
    taskRulings: input.taskRulings,
    taskText: input.taskText,
    carriedAttachments: input.carriedAttachments,
    spec: input.originalPrompt,
  })
}
