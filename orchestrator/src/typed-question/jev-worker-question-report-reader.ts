// concern: jev-worker-question-report-reader
/** Reads worker-question advice rows and delegates their measurement to the pure report. */

import type { Database } from 'bun:sqlite'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { jevThresholds } from '../ask/jev-routing.ts'
import { db } from '../database/db.ts'
import { questionRulings } from '../question-store/question-store-read.ts'
import {
  type JevWorkerQuestionMetrics,
  type JevWorkerQuestionRow,
  jevWorkerQuestionMetrics,
} from './jev-worker-question-report.ts'

export async function jevWorkerQuestionReport(
  options: { days?: number },
  database: Database = db(),
  readMachine: (
    key: 'jev.confidence_threshold' | 'jev.fit_threshold',
  ) => string | number = readMachineValue,
): Promise<JevWorkerQuestionMetrics[]> {
  const since =
    options.days === undefined
      ? undefined
      : new Date(Date.now() - options.days * 24 * 60 * 60 * 1000).toISOString()
  const rows = (await questionRulings(database, { kind: 'all', since })).items.filter(
    (row) =>
      row.jev_pick !== null &&
      ['choice', 'yesno', 'score'].includes(String(row.kind)) &&
      (since === undefined || String(row.asked_at) >= since),
  ) as unknown as JevWorkerQuestionRow[]
  const thresholds = jevThresholds(readMachine)
  if (!thresholds.ok) throw new Error(thresholds.error)
  return jevWorkerQuestionMetrics(rows, thresholds.threshold, thresholds.fitThreshold)
}
