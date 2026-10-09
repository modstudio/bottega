export type TaskDocumentLabel = { taskKey: string; number: number }

export function formatTaskDocumentLabel(taskKey: string, number: number): string {
  return `${taskKey.toUpperCase()}/${number}`
}

export function parseTaskDocumentLabel(value: string): TaskDocumentLabel {
  const match = /^([A-Za-z][A-Za-z0-9]*-[1-9][0-9]*)\/([1-9][0-9]*)$/.exec(value)
  if (!match) {
    const key = /^([A-Za-z][A-Za-z0-9]*-[1-9][0-9]*)/.exec(value)?.[1]?.toUpperCase() ?? '<KEY>'
    throw new Error(
      `invalid task document '${value}': expected label ${key}/<number> or a document UUID; run \`hub task doc list ${key}\``,
    )
  }
  const number = Number(match[2])
  if (!Number.isSafeInteger(number)) {
    throw new Error(
      `invalid task document '${value}': expected label ${match[1]!.toUpperCase()}/<number> or a document UUID; run \`hub task doc list ${match[1]!.toUpperCase()}\``,
    )
  }
  return { taskKey: match[1]!.toUpperCase(), number }
}
