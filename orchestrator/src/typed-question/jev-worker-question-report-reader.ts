// concern: jev-worker-question-report-reader
/** Reads worker-question advice rows and delegates their measurement to the pure report. */

import type { Database } from 'bun:sqlite'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { invalidJevThresholdRemedy, isJevConfidenceThreshold } from '../ask/jev-routing.ts'
import { db } from '../database/db.ts'
import {
  type JevWorkerQuestionMetrics,
  type JevWorkerQuestionRow,
  jevWorkerQuestionMetrics,
} from './jev-worker-question-report.ts'

export function jevWorkerQuestionReport(
  options: { days?: number },
  database: Database = db(),
  readMachine: (
    key: 'jev.confidence_threshold' | 'jev.fit_threshold',
  ) => string | number = readMachineValue,
): JevWorkerQuestionMetrics[] {
  const rows = database
    .query(
      `SELECT kind,jev_model,jev_pick,jev_probabilities,jev_agreed,jev_question_version,jev_fits,jev_order_flipped
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
    throw new Error(invalidJevThresholdRemedy('jev.confidence_threshold', rawThreshold))
  const rawFitThreshold = readMachine('jev.fit_threshold')
  const fitThreshold = Number(rawFitThreshold)
  if (!isJevConfidenceThreshold(fitThreshold))
    throw new Error(invalidJevThresholdRemedy('jev.fit_threshold', rawFitThreshold))
  return jevWorkerQuestionMetrics(rows, threshold, fitThreshold)
}
