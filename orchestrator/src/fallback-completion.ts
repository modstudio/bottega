// concern: fallback-completion
/** Decides whether a done-shaped fallback is evidence of completed work. */

import { OPENING_PROGRESS_VOCABULARY } from './evidence/premature-final.ts'

const CONTINUING_PROGRESS_VOCABULARY =
  /\b(?:still (?:executing|running|collecting|waiting)|continuing to|i(?:'m| am) continuing|another (?:short )?(?:collection|window|attempt)|then i(?:'ll| will)|has not yet (?:exited|finished|printed))\b/i

export type FallbackCompletionFacts = {
  writesJob: boolean
  timedOut: boolean
  replyFilePresent: boolean
  finalMessage: string
}

function textFields(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(textFields)
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(textFields)
}

function parsedFallbackHasEvidence(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const reply = value as {
    files_changed?: unknown
    tests?: { ran?: unknown } | null
  }
  return (
    (Array.isArray(reply.files_changed) && reply.files_changed.length > 0) ||
    reply.tests?.ran === true
  )
}

function progressTextFields(finalMessage: string): string[] | null {
  try {
    const parsed = JSON.parse(finalMessage)
    return parsedFallbackHasEvidence(parsed) ? null : textFields(parsed)
  } catch {
    return [finalMessage]
  }
}

function isProgressUpdate(finalMessage: string): boolean {
  return Boolean(
    progressTextFields(finalMessage)?.some(
      (text) => OPENING_PROGRESS_VOCABULARY.test(text) || CONTINUING_PROGRESS_VOCABULARY.test(text),
    ),
  )
}

/** Answer whether an already parsed done status counts as a completed reply. */
export function decideFallbackCompletion(facts: FallbackCompletionFacts): boolean {
  if (facts.replyFilePresent || !facts.writesJob) return true
  if (facts.timedOut) return false
  return !isProgressUpdate(facts.finalMessage)
}
