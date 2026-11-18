export type HostedBoardWriteResponse = {
  id: string
  duplicateOf?: string | null
}

export type HostedBoardWriteResult = {
  dropped: boolean
  duplicateOf: string | null
}

/** Guards hosted board writes from deciding `dropped` with a literal instead of the server response. */
export function hostedBoardWriteResult(
  mintedId: string,
  response: HostedBoardWriteResponse,
): HostedBoardWriteResult {
  const carriesDuplicateOf = Object.hasOwn(response, 'duplicateOf')
  const duplicateOf = carriesDuplicateOf
    ? (response.duplicateOf ?? null)
    : response.id === mintedId
      ? null
      : response.id
  return { dropped: duplicateOf !== null, duplicateOf }
}

export function boardDuplicateWarning(duplicateOf: string): string {
  return `Duplicate of live board message ${duplicateOf}; withdraw it with bottega board withdraw ${duplicateOf} and post anew.`
}
