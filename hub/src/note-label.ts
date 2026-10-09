export type NoteLabel = { project: string; number: number }

export function formatNoteLabel(project: string, number: number): string {
  return `${project}#${number}`
}

export function parseNoteLabel(value: string): NoteLabel {
  const separator = value.lastIndexOf('#')
  const project = value.slice(0, separator)
  const numberText = value.slice(separator + 1)
  const number = Number(numberText)
  if (
    separator < 1 ||
    !numberText ||
    !/^[1-9][0-9]*$/.test(numberText) ||
    !Number.isSafeInteger(number)
  ) {
    throw new Error(`invalid note label '${value}': expected project#number`)
  }
  return { project, number }
}
