export type FilesystemIdentityRun = {
  number: string
  recordId: string
  projectPath?: string | null
}

export type FilesystemIdentityProject = { name: string; path: string }

type FilesystemIdentityMove<T = undefined> = {
  source: string
  destination: string
  run: FilesystemIdentityRun
  payload: T
}

type FilesystemIdentityUnmapped = { source: string; number: string; reason?: string }

export type FilesystemIdentityPlan<T = undefined> = {
  mapped: FilesystemIdentityMove<T>[]
  collisions: FilesystemIdentityMove<T>[]
  unmapped: FilesystemIdentityUnmapped[]
}
