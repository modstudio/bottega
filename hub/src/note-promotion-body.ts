import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { NoteAnchorWire } from '../../shared/note-anchor.ts'

export type NotePromotionAnchor = Pick<
  NoteAnchorWire,
  'cwd' | 'branch' | 'commit' | 'run_record_id' | 'session_id'
>

export const PROMOTED_TASK_TITLE_REFUSAL = 'a promoted task needs a title stating its point'
export const HOSTED_PROMOTION_TITLE_REFUSAL = `${PROMOTED_TASK_TITLE_REFUSAL}; run \`${PLATFORM_SLUG} machine update\` and retry`

/** The refusal every creating promotion carries, so no surface can create a task titled by a note. */
export function promotionTitleRefusal(label: string): string {
  return `${PLATFORM_SLUG} note promote ${label} --title "<the point>"`
}

export function requiredPromotionTitle(
  supplied: string | undefined,
  refusal = PROMOTED_TASK_TITLE_REFUSAL,
): string {
  const title = (supplied ?? '').trim()
  if (!title) throw new Error(refusal)
  return title
}

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
