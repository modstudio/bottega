// concern: resume brief handoff adapter
/** Resolves a consumed brief's author and attempts a consent-relaxed session adoption. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, sessionId } from '../database/db.ts'
import {
  type ConsumedDoc,
  resumeBriefAuthorSession,
} from '../doc/resume-brief-author.ts'
import type { SessionProcessProbe } from '../run/session-liveness-adapter.ts'
import { adoptSessionRuns, type SessionAdoptionReport } from './session-adopt.ts'

export type ResumeBriefHandoff = {
  authorSession: string | null
  status: 'moved' | 'skipped' | 'refused'
  report: SessionAdoptionReport | null
  lines: string[]
}

function skippedHandoff(doc: ConsumedDoc): ResumeBriefHandoff | null {
  if (doc.scope !== 'resume')
    return {
      authorSession: null,
      status: 'skipped',
      report: null,
      lines: ['resume handoff skipped: consumed document is not a resume brief'],
    }
  if (doc.already_consumed)
    return {
      authorSession: null,
      status: 'skipped',
      report: null,
      lines: ['resume handoff skipped: resume brief was already consumed'],
    }
  return null
}

function adoptionHandoff(
  author: string,
  report: SessionAdoptionReport,
  command: string,
): ResumeBriefHandoff {
  const remaining = report.notMoved.length
  if (report.totalRuns > 0)
    return {
      authorSession: author,
      status: 'moved',
      report,
      lines: [
        `resume handoff moved ${report.totalRuns} run(s) and ${report.totalTurns} turn(s) from ${author} to ${report.toSession}${remaining ? `; ${remaining} run(s) remain with ${author}; run ${command}` : ''}`,
      ],
    }
  if (remaining)
    return {
      authorSession: author,
      status: 'refused',
      report,
      lines: [
        `resume handoff did not move runs: ${remaining} run(s) remain with ${author}; run ${command}`,
      ],
    }
  return {
    authorSession: author,
    status: 'moved',
    report,
    lines: [`resume handoff: session ${author} owns no runs`],
  }
}

export async function handoffConsumedResumeBrief(
  doc: ConsumedDoc,
  options: { database?: Database; probe?: SessionProcessProbe; machine?: string } = {},
): Promise<ResumeBriefHandoff> {
  const database = options.database ?? db()
  const skipped = skippedHandoff(doc)
  if (skipped) return skipped
  let author: string | null
  try {
    author = await resumeBriefAuthorSession(doc, database)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      authorSession: null,
      status: 'refused',
      report: null,
      lines: [`resume handoff failed: ${message}`],
    }
  }
  if (!author)
    return {
      authorSession: null,
      status: 'skipped',
      report: null,
      lines: ['resume handoff skipped: brief author session is unknown'],
    }
  const actor = sessionId(database)
  if (author === actor)
    return {
      authorSession: author,
      status: 'skipped',
      report: null,
      lines: ['resume handoff skipped: brief author is the current session'],
    }
  const command = `${PLATFORM_SLUG} session adopt ${author} --reason "resume brief ${doc.subject}/${doc.slug} consumed by ${actor ?? 'successor'}"`
  try {
    const report = adoptSessionRuns(
      author,
      `resume brief ${doc.subject}/${doc.slug} consumed by ${actor}`,
      { consent: 'resume-handoff', database, probe: options.probe, machine: options.machine },
    )
    return adoptionHandoff(author, report, command)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      authorSession: author,
      status: 'refused',
      report: null,
      lines: [`resume handoff did not move runs: ${message}; run ${command}`],
    }
  }
}
