import type { NoteAnchorWire } from '../../shared/note-anchor.ts'

export type NotePromotionAnchor = Pick<
  NoteAnchorWire,
  'cwd' | 'branch' | 'commit' | 'run_record_id' | 'session_id'
>

export const PROMOTED_TASK_TITLE_REFUSAL = 'a promoted task needs a title stating its point'

export function notePromotionBody(
  text: string,
  sightings: number,
  anchors: readonly NotePromotionAnchor[],
): string {
  const evidence = anchors
    .map(
      (anchor, index) =>
        `Sighting ${index + 1}: cwd=${anchor.cwd}; branch=${anchor.branch ?? '-'}; commit=${anchor.commit ?? '-'}; run=${anchor.run_record_id ?? '-'}; session=${anchor.session_id ?? '-'}`,
    )
    .join('\n')
  return `${text}\n\nSIGHTINGS (${sightings})\n${evidence}`
}
