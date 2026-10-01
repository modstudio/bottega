// concern: Docker resource main-checkout protection

import { resolve } from 'node:path'

type ComposeResource = {
  workingDir?: string | null
  composeProject?: string | null
}

/** Mark direct and same-Compose-project resources protected by a registered main checkout. */
export function markMainCheckoutResources<T extends ComposeResource>(
  rows: T[],
  observed: readonly ComposeResource[],
  paths: string[],
): T[] {
  const mainPaths = new Set(paths.map((path) => resolve(path)))
  const mainComposeProjects = new Set(
    observed
      .filter((row) => row.workingDir && mainPaths.has(resolve(row.workingDir)))
      .flatMap((row) => (row.composeProject ? [row.composeProject] : [])),
  )
  return rows.map((row) => ({
    ...row,
    mainCheckout:
      Boolean(row.workingDir && mainPaths.has(resolve(row.workingDir))) ||
      Boolean(row.composeProject && mainComposeProjects.has(row.composeProject)),
  }))
}
