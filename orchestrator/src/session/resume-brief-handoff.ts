// concern: resume brief handoff adapter
/** Resolves a consumed brief's author and attempts a consent-relaxed session adoption. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, sessionId } from '../database/db.ts'
import { parseResumeFrontmatter } from '../doc/doc-resume-frontmatter.ts'
import type { ConsumedDoc, Doc } from '../doc/docs.ts'
import {
  type ResumeBriefAuthorOptions,
  resumeBriefAuthorSession,
} from '../doc/resume-brief-author.ts'
import type { SessionProcessProbe } from '../run/session-liveness-adapter.ts'
import {
  type AdoptionOptions,
  adoptSessionRuns,
  type SessionAdoptionReport,
} from './session-adopt.ts'

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
  const remainingWithAuthor = report.notMoved.filter(({ currentOwner }) => currentOwner === author)
  const ownedElsewhere = report.notMoved.filter(({ currentOwner }) => currentOwner !== author)
  const remaining = report.notMoved.length
  const outcomes = [
    remainingWithAuthor.length
      ? `${remainingWithAuthor.length} run(s) remain with ${author}; run ${command}`
      : null,
    ...ownedElsewhere.map(
      ({ recordId, currentOwner }) =>
        `run ${recordId} is now owned by ${currentOwner ?? 'no session'}`,
    ),
  ].filter((outcome): outcome is string => outcome !== null)
  if (report.totalRuns > 0)
    return {
      authorSession: author,
      status: 'moved',
      report,
      lines: [
        `resume handoff moved ${report.totalRuns} run(s) and ${report.totalTurns} turn(s) from ${author} to ${report.toSession}${remaining ? `; ${outcomes.join('; ')}` : ''}`,
      ],
    }
  if (remaining)
    return {
      authorSession: author,
      status: 'refused',
      report,
      lines: [`resume handoff did not move runs: ${outcomes.join('; ')}`],
    }
  return {
    authorSession: author,
    status: 'moved',
    report,
    lines: [`resume handoff: session ${author} owns no runs`],
  }
}

type ResumeBriefHandoffOptions = {
  database?: Database
  probe?: SessionProcessProbe
  machine?: string
  transfer?: AdoptionOptions['transfer']
  author?: ResumeBriefAuthorOptions
}

async function handoffFromAuthor(
  doc: ConsumedDoc,
  author: string | null,
  options: ResumeBriefHandoffOptions,
): Promise<ResumeBriefHandoff> {
  const database = options.database ?? db()
  if (!author)
    return {
      authorSession: null,
      status: 'skipped',
      report: null,
      lines: [
        `resume handoff skipped: latest non-consume hosted revision has no author session; when the author session is known, run ${PLATFORM_SLUG} session adopt <session> --reason <why>`,
      ],
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
      {
        consent: 'resume-handoff',
        database,
        probe: options.probe,
        machine: options.machine,
        transfer: options.transfer,
      },
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

export async function prepareResumeBriefHandoff(
  doc: Doc | null,
  options: ResumeBriefHandoffOptions = {},
): Promise<(consumed: ConsumedDoc) => Promise<ResumeBriefHandoff>> {
  const alreadyConsumed =
    doc?.scope === 'resume' && parseResumeFrontmatter(doc.body)?.status === 'consumed'
  if (doc?.scope !== 'resume' || alreadyConsumed)
    return (consumed) => handoffConsumedResumeBrief(consumed, options)
  const author = await resumeBriefAuthorSession(doc, options.database ?? db(), options.author)
  return (consumed) => handoffFromAuthor(consumed, author, options)
}

export const resumeBriefHandoff = {
  prepare: prepareResumeBriefHandoff,
}

export async function handoffConsumedResumeBrief(
  doc: ConsumedDoc,
  options: ResumeBriefHandoffOptions = {},
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
  return handoffFromAuthor(doc, author, options)
}
