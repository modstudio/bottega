export type NotePromotionAnchor = {
  cwd: string
  branch: string | null
  commit: string | null
  run_id: number | null
  session_id: string | null
}

export function notePromotionBody(
  text: string,
  sightings: number,
  anchors: readonly NotePromotionAnchor[],
): string {
  const evidence = anchors
    .map(
      (anchor, index) =>
        `Sighting ${index + 1}: cwd=${anchor.cwd}; branch=${anchor.branch ?? '-'}; commit=${anchor.commit ?? '-'}; run=${anchor.run_id ?? '-'}; session=${anchor.session_id ?? '-'}`,
    )
    .join('\n')
  return `${text}\n\nSIGHTINGS (${sightings})\n${evidence}`
}
