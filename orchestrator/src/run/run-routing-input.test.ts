import { describe, expect, test } from 'bun:test'
import { job } from '../jobs/jobs.ts'
import { PROMPT_SIZE_BOUNDARY, promptSizeBucket } from '../route/prompt-size-bucket.ts'
import { runEvidence } from './run-evidence-context.ts'
import { routedPromptBytes, routedPromptText } from './run-routing-input.ts'

const REPLY_SCHEMA_NAME = 'WORKER_SCHEMA'
const REQUESTED_JOB = job('file-question')
/** file-question asks for a reply, not for a canon source. */
const REQUIRES_CANON_SOURCE = false

const measuredBytes = (prompt: string): number =>
  routedPromptBytes(prompt, REPLY_SCHEMA_NAME, REQUESTED_JOB, REQUIRES_CANON_SOURCE)

const readerInstructionFor = (jobName: string): string => {
  const instruction = runEvidence(jobName, false, []).readerInstruction
  if (!instruction) throw new Error(`${jobName} declares no reader instruction to measure`)
  return instruction
}

describe('routed prompt composition', () => {
  test('a prompt just under the boundary is measured over it once its reader instruction is counted', () => {
    const instruction = readerInstructionFor('file-question')
    // The bytes both routing call sites pay before the prompt itself: the reply
    // contract and its separator.
    const overhead = measuredBytes('')
    const prompt = 'q'.repeat(PROMPT_SIZE_BOUNDARY - overhead - 1)

    expect(promptSizeBucket(measuredBytes(prompt))).toBe('small')
    const composed = routedPromptText(prompt, instruction, true)
    expect(promptSizeBucket(measuredBytes(composed))).toBe('large')
    // Exactly the prefix, so neither call site can count it twice or drop it.
    expect(Buffer.byteLength(composed) - Buffer.byteLength(prompt)).toBe(
      Buffer.byteLength(instruction) + 2,
    )
  })

  test('the reader instruction is a first-turn prefix, and only when there is one', () => {
    const instruction = readerInstructionFor('diagnose')
    expect(routedPromptText('spec', instruction, true)).toBe(`${instruction}\n\nspec`)
    expect(routedPromptText('spec', instruction, false)).toBe('spec')
    expect(routedPromptText('spec', null, true)).toBe('spec')
  })
})
