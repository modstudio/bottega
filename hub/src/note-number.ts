/** Next public note number: one past max(existing) unless the seq row is already ahead. */

export function nextNoteNumber(highest: bigint, sequenceNext: bigint) {
  return highest + 1n > sequenceNext ? highest + 1n : sequenceNext
}
