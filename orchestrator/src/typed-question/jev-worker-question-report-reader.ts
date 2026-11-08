// concern: jev-worker-question-report-reader
/** Reads worker-question advice rows and delegates their measurement to the pure report. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { isJevConfidenceThreshold } from '../ask/jev-routing.ts'
import { db } from '../database/db.ts'
import {
  type JevWorkerQuestionMetrics,
  type JevWorkerQuestionRow,
  jevWorkerQuestionMetrics,
} from './jev-worker-question-report.ts'

export function jevWorkerQuestionReport(
  options: { days?: number },
  database: Database = db(),
  readMachine: (key: 'jev.confidence_threshold') => string | number = readMachineValue,
): JevWorkerQuestionMetrics[] {
  const rows = database
    .query(
      `SELECT kind,jev_model,jev_pick,jev_probabilities,jev_agreed
         FROM question
        WHERE jev_pick IS NOT NULL
          AND kind IN ('choice','yesno','score')
          ${options.days === undefined ? '' : "AND datetime(asked_at) >= datetime('now', '-' || ? || ' days')"}
        ORDER BY asked_at`,
    )
    .all(...(options.days === undefined ? [] : [options.days])) as JevWorkerQuestionRow[]
  const rawThreshold = readMachine('jev.confidence_threshold')
  const threshold = Number(rawThreshold)
  if (!isJevConfidenceThreshold(threshold))
    throw new Error(
      `invalid jev.confidence_threshold ${JSON.stringify(rawThreshold)}; run ${PLATFORM_SLUG} machine config set jev.confidence_threshold <0-1>`,
    )
  return jevWorkerQuestionMetrics(rows, threshold)
}
