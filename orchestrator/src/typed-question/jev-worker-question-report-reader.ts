// concern: jev-worker-question-report-reader
/** Reads worker-question advice rows and delegates their measurement to the pure report. */

import type { Database } from 'bun:sqlite'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { db } from '../database/db.ts'
import {
  type JevWorkerQuestionMetrics,
  type JevWorkerQuestionRow,
  jevWorkerQuestionMetrics,
} from './jev-worker-question-report.ts'

export function jevWorkerQuestionReport(
  options: { days?: number },
  database: Database = db(),
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
  return jevWorkerQuestionMetrics(rows, Number(readMachineValue('jev.confidence_threshold')))
}
