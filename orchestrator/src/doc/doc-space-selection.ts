// concern: document-space-selection
/** Decides whether a document address reads every space available to the caller. */

export type DocSpaceAddress = {
  scope: string | undefined
  subject: string | null | undefined
  owner: string | null | undefined
}

export function docReadsAcrossReadableSpaces(address: DocSpaceAddress): boolean {
  return address.subject === undefined && address.owner == null
}
