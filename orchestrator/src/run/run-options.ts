// concern: run-options
/** Declares the caller-owned inputs to one run lifecycle. */
import type { Pack } from '../canon/canon.ts'
import type { McpRequest } from '../mcp/mcp-preflight.ts'
import type { ReviewRole } from '../review/review-role.ts'
import type { ResolvedTaskBranch } from '../route/failover.ts'
import type { RoutedSelection } from '../route/route.ts'
import type { TransportName } from '../transport/transport.ts'
import type { KeepTreeExemption } from '../worktree/keep-tree-hold.ts'
import type { RunResumeOptions } from './run-resume-options.ts'

export type RunOptions = {
  job: string
  prompt: string
  agent?: string
  agentExplicit?: boolean
  routedAgent?: RoutedSelection
  dispatchMcpPreflightedAgent?: string
  schemaPath?: string
  mcp?: McpRequest
  probe?: boolean
  label?: string
  lens?: string
  reviewRole?: ReviewRole
  model?: string
  transport?: TransportName
  cwd?: string
  canonPack?: Pack
  launchCwd?: string
  repo?: string
  retryOf?: string
  noFailover?: boolean
  noWaitCapacity?: boolean
  ownerSession?: string | null
  automaticFailover?: boolean
  seed?: string
  key?: string
  base?: string
  launchBase?: string
  resolvedTaskBranch?: ResolvedTaskBranch | null
  avoid?: string[]
  distinctModels?: string[]
  carry?: boolean
  review?: string
  reserveId?: string
  resume?: RunResumeOptions
  deliverables?: string[]
  timeoutMinutes?: number
  keepTree?: KeepTreeExemption
  resolvedReviewTarget?: { branch: string; commit: string; base: string }
}
