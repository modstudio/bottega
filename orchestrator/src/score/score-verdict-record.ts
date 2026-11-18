// concern: score-verdict-record
/** Persists the current verdict for one run without deciding whether it is valid. */

import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type { Delivery, Fidelity, Quality } from './score.ts'

export function recordScoreVerdict(
  id: string,
  delivery: Delivery,
  quality: Quality | null,
  fidelity: Fidelity | null,
  note: string | null,
  scoredAt: string,
  scorer: string,
): void {
  db()
    .query(
      `INSERT INTO score (record_id, run_record_id, delivery, quality, fidelity, note, scored_at, scored_by)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(run_record_id) DO UPDATE SET delivery=excluded.delivery, quality=excluded.quality,
                                       fidelity=excluded.fidelity,
                                       note=CASE
                                         WHEN score.note IS NULL OR trim(score.note) = ''
                                           THEN excluded.note
                                         WHEN excluded.note IS NULL OR trim(excluded.note) = ''
                                           THEN score.note
                                         ELSE score.note || '\\n\\n--- re-scored ' ||
                                           excluded.scored_at || ' ---\\n' || excluded.note
                                       END,
                                       scored_at=excluded.scored_at`,
    )
    .run(newRecordId(), id, delivery, quality, fidelity, note, scoredAt, scorer)
}
