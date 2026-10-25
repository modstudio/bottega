// concern: score
/** Owns the scorer-facing explanation of a worker refusal. */

import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { parseWorkerReplyWithCount } from '../contract/contract-reply.ts'

const STATUS_SUMMARY_SCHEMA = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['done', 'asking', 'refused'] },
    summary: { type: 'string' },
  },
} as const

function refusalScoreGuidance(text: string, writingJob: boolean): string | null {
  // Terminalisation already validated the full worker contract. Re-run its
  // recovery parser over only the two fields this presentation needs, keeping
  // collection's deliberately small import graph free of lifecycle modules.
  const reply = parseWorkerReplyWithCount<{ status: string; summary: string }>(
    text,
    STATUS_SUMMARY_SCHEMA,
  ).reply
  if (reply?.status !== 'refused') return null
  const summary = reply.summary.split(/\r?\n/, 1)[0] ?? ''
  return (
    `refused: ${JSON.stringify(summary)}; judge the refusal on its merits ` +
    `(correct with evidence: full right${writingJob ? ' faithful' : ''}; should have asked: ` +
    `full mixed${writingJob ? ' faithful' : ''}; false evidence: full wrong; no evidence: none), or rule and continue ` +
    'the chain and score it after.'
  )
}

export function refusalScoreGuidanceFromPath(
  outputPath: string | null,
  writingJob: boolean,
): string | null {
  if (!outputPath) return null
  try {
    return refusalScoreGuidance(readFileSync(outputPath, 'utf8'), writingJob)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Read the newest turn because the root owns the score for the whole conversation. */
export function refusalScoreGuidanceForRun(
  database: Database,
  runId: string,
  writingJob: boolean,
): string | null {
  const member = database
    .query('SELECT record_id, parent_run_record_id FROM run WHERE record_id=?')
    .get(runId) as { record_id: string; parent_run_record_id: string | null } | null
  if (!member) return null
  const rootId = member.parent_run_record_id ?? member.record_id
  const latest = database
    .query(
      `SELECT output_path FROM run
       WHERE record_id=? OR parent_run_record_id=?
       ORDER BY turn DESC, number DESC LIMIT 1`,
    )
    .get(rootId, rootId) as { output_path: string | null } | null
  return refusalScoreGuidanceFromPath(latest?.output_path ?? null, writingJob)
}
