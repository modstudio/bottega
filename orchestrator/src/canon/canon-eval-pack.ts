export const EMPTY_CANON_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export type CanonEvalProject = {
  name: string
  path: string
}

export function decideCanonEvalPack(input: {
  requestedProjectName?: string
  requestedProject: CanonEvalProject | null
  cwdProject: CanonEvalProject | null
  pack?: { project: string | null; canonBytes: number; sha256: string }
}): { project: CanonEvalProject; canonSha: string | null } {
  let project: CanonEvalProject
  if (input.requestedProjectName) {
    if (!input.requestedProject) {
      throw new Error(`unknown project ${JSON.stringify(input.requestedProjectName)}`)
    }
    project = input.requestedProject
  } else if (input.cwdProject) {
    project = input.cwdProject
  } else {
    throw new Error('current directory is not in a registered project; pass --project <name>')
  }
  if (!input.pack) return { project, canonSha: null }
  if (input.pack.project !== project.name) {
    throw new Error(
      `canon eval for project ${JSON.stringify(project.name)} compiled pack for ${JSON.stringify(input.pack.project)}`,
    )
  }
  if (input.pack.canonBytes === 0 || input.pack.sha256 === EMPTY_CANON_SHA) {
    throw new Error(
      `canon eval project ${JSON.stringify(project.name)} has no canon; refusing empty pack`,
    )
  }
  return { project, canonSha: input.pack.sha256 }
}
