export const EMPTY_CANON_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export type CanonEvalProject = {
  name: string
  path: string
}

export function resolveCanonEvalProject(input: {
  requestedProjectName?: string
  requestedProject: CanonEvalProject | null
  cwdProject: CanonEvalProject | null
}): CanonEvalProject {
  if (input.requestedProjectName) {
    if (!input.requestedProject) {
      throw new Error(`unknown project ${JSON.stringify(input.requestedProjectName)}`)
    }
    return input.requestedProject
  }
  if (input.cwdProject) return input.cwdProject
  throw new Error('current directory is not in a registered project; pass --project <name>')
}

export function decideCanonEvalPack(input: {
  project: CanonEvalProject
  pack: { project: string | null; canonBytes: number; sha256: string }
}): { canonSha: string } {
  if (input.pack.project !== input.project.name) {
    throw new Error(
      `canon eval for project ${JSON.stringify(input.project.name)} compiled pack for ${JSON.stringify(input.pack.project)}`,
    )
  }
  if (input.pack.canonBytes === 0 || input.pack.sha256 === EMPTY_CANON_SHA) {
    throw new Error(
      `canon eval project ${JSON.stringify(input.project.name)} has no canon; refusing empty pack`,
    )
  }
  return { canonSha: input.pack.sha256 }
}
