import type { ToolchainFacts } from './setup-toolchain.ts'

export type RepositoryFacts = ToolchainFacts & {
  name: string
  path: string
  currentBranch: string | null
  clean: boolean
  originUrl: string | null
  originHost: string | null
  remoteDefaultBranch: string | null
  stack: string | null
  inspectionTimedOut: boolean
}
