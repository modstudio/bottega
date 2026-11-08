// concern: score
/** Owns the scorer-facing explanation of a worker refusal. */

import { readFileSync } from 'node:fs'
import { parseWorkerReplyWithCount, type SchemaValidatorPort } from '../contract/contract-reply.ts'
import { jobTakesFidelity } from '../jobs/job-fidelity.ts'

const REFUSAL_QUOTE_CHARS = 200

const STATUS_SUMMARY_SCHEMA = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['done', 'asking', 'refused'] },
    summary: { type: 'string' },
  },
} as const

// Collection runs in trees without orchestrator/node_modules, so this check
// stays a plain predicate over the two fields rather than loading Ajv.
const matchesStatusSummary: SchemaValidatorPort = (value) => {
  const [statusField, summaryField] = STATUS_SUMMARY_SCHEMA.required
  const record =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const status = record[statusField]
  if (typeof status !== 'string') {
    return { ok: false, failures: [`/${statusField} type: must be string`] }
  }
  if (!STATUS_SUMMARY_SCHEMA.properties.status.enum.some((allowed) => allowed === status)) {
    return {
      ok: false,
      failures: [`/${statusField} enum: must be equal to one of the allowed values`],
    }
  }
  if (typeof record[summaryField] !== 'string') {
    return { ok: false, failures: [`/${summaryField} type: must be string`] }
  }
  return { ok: true }
}

export function refusalScoreGuidance(text: string | null, jobName: string): string | null {
  if (text === null) return null
  // Terminalisation already validated the full worker contract. Re-run its
  // recovery parser over only the two fields this presentation needs, keeping
  // collection's deliberately small import graph free of lifecycle modules.
  const reply = parseWorkerReplyWithCount<{ status: string; summary: string }>(
    text,
    STATUS_SUMMARY_SCHEMA,
    matchesStatusSummary,
  ).reply
  if (reply?.status !== 'refused') return null
  const firstLine = reply.summary.split(/\r?\n/, 1)[0] ?? ''
  let summary = firstLine
  if (firstLine.length > REFUSAL_QUOTE_CHARS) {
    let cut = REFUSAL_QUOTE_CHARS
    for (let index = REFUSAL_QUOTE_CHARS; index >= 0; index -= 1) {
      if (/\s/.test(firstLine[index] ?? '')) {
        cut = index
        break
      }
    }
    summary = `${firstLine.slice(0, cut)}…`
  }
  return (
    `refused: ${JSON.stringify(summary)}; judge the refusal on its merits ` +
    `(correct with evidence: full right${jobTakesFidelity(jobName) ? ' faithful' : ''}; should have asked: ` +
    `full mixed${jobTakesFidelity(jobName) ? ' faithful' : ''}; false evidence: full wrong; no evidence: none), or rule and continue ` +
    'the chain and score it after.'
  )
}

export function refusalScoreGuidanceFromPath(
  outputPath: string | null,
  jobName: string,
): string | null {
  if (!outputPath) return null
  try {
    return refusalScoreGuidance(readFileSync(outputPath, 'utf8'), jobName)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
