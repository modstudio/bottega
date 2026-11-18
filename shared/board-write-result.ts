import { PLATFORM_SLUG } from './brand.ts'

export type HostedBoardWriteResponse = {
  id: string
  duplicateOf?: string | null
}

declare const boardWriteDroppedBrand: unique symbol

/** Prevents board write results from assigning `dropped` from a boolean literal. */
export type BoardWriteDropped = boolean & { readonly [boardWriteDroppedBrand]: true }

export type BoardWriteDecision = {
  dropped: BoardWriteDropped
  duplicateOf: string | null
}

const boardWriteDropped = (value: boolean): BoardWriteDropped => value as BoardWriteDropped

/** Derives the hosted duplicate decision only from the server response. */
export function hostedBoardWriteResult(
  mintedId: string,
  response: HostedBoardWriteResponse,
): BoardWriteDecision {
  const carriesDuplicateOf = Object.hasOwn(response, 'duplicateOf')
  const duplicateOf = carriesDuplicateOf
    ? (response.duplicateOf ?? null)
    : response.id === mintedId
      ? null
      : response.id
  return { dropped: boardWriteDropped(duplicateOf !== null), duplicateOf }
}

/** Derives the local duplicate decision from the matched message id. */
export function localBoardWriteResult(duplicateOf: string | null): BoardWriteDecision {
  return { dropped: boardWriteDropped(duplicateOf !== null), duplicateOf }
}

export function boardDuplicateWarning(duplicateOf: string): string {
  return `Duplicate of live board message ${duplicateOf}; withdraw it with ${PLATFORM_SLUG} board withdraw ${duplicateOf} and post anew.`
}

export function boardReplyDuplicateWarning(duplicateOf: string, rootId: string): string {
  return `Duplicate of live reply ${duplicateOf} in thread ${rootId}; it is already posted.`
}

export function boardWriteWarning(
  result: BoardWriteDecision,
  context: { kind: 'root' } | { kind: 'reply'; rootId: string },
): string | null {
  if (result.duplicateOf === null) return null
  return context.kind === 'reply'
    ? boardReplyDuplicateWarning(result.duplicateOf, context.rootId)
    : boardDuplicateWarning(result.duplicateOf)
}
