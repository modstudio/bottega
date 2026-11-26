// concern: project-gets-pack
/** Decides whether a registered project receives pack-wide canon checks. */

export function projectGetsPack(input: {
  retiredAt: string | null
  declaredSpace: string | null
  hostedRead: boolean
}): boolean {
  return input.retiredAt === null && (!input.hostedRead || input.declaredSpace !== null)
}
