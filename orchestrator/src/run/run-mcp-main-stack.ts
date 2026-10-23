// concern: MCP run main-stack preflight

import type { McpConnection, McpRequest } from '../mcp/mcp-preflight.ts'
import {
  type DeferredCwdMcpStep,
  decideDeferredCwdMcpPlan,
  preflightMcp,
  probeRequestedMcp,
  requestedMcpMode,
} from '../mcp/mcp-preflight.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { ensureProjectMainStack } from '../resources/main-stack.ts'

export function prepareRunMcpPreflight(input: {
  mcpRequest: McpRequest | undefined
  callerCwd: string
  projectName?: string
  forbidsRepo: boolean
  repoJob: boolean
  discoversMcpFromCwd: boolean
  agent: string
}): { deferredCwdMcpPlan: DeferredCwdMcpStep[]; mcpConnection: McpConnection | null } {
  const cwdProject = projectAt(input.callerCwd)
  const project = input.projectName ? projectByName(input.projectName) : cwdProject
  const deferredCwdMcpPlan = decideDeferredCwdMcpPlan({
    mcpRequest: input.mcpRequest,
    callerCwdHasProject: Boolean(cwdProject),
    forbidsRepo: input.forbidsRepo,
    repoJob: input.repoJob,
    discoversMcpFromCwd: input.discoversMcpFromCwd,
  })
  if (!deferredCwdMcpPlan.length && requestedMcpMode(input.mcpRequest) && project) {
    ensureProjectMainStack(project, 'mcp')
  }
  return {
    deferredCwdMcpPlan,
    mcpConnection: deferredCwdMcpPlan.length
      ? null
      : probeRequestedMcp(input.mcpRequest, input.agent, input.callerCwd),
  }
}

function ensureDispatchMcpMainStack(input: {
  mcpRequest: McpRequest
  cwd: string
  projectName?: string
}): void {
  const project = input.projectName ? projectByName(input.projectName) : projectAt(input.cwd)
  if (project) ensureProjectMainStack(project, 'mcp')
}

export function preflightDispatchMcp(input: {
  mcpRequest: McpRequest | undefined
  cwd: string
  job: string
  selectedAgent: string
  projectName?: string
}): void {
  if (!input.mcpRequest) return
  ensureDispatchMcpMainStack({
    mcpRequest: input.mcpRequest,
    cwd: input.cwd,
    projectName: input.projectName,
  })
  preflightMcp({
    mcp: input.mcpRequest,
    cwd: input.cwd,
    job: input.job,
    selectedAgent: input.selectedAgent,
  })
}

export async function selectAgentAndPreflightMcp<T extends { agent: string }>(input: {
  select: () => Promise<T>
  mcpRequest: McpRequest | undefined
  cwd: string
  job: string
  projectName?: string
  preflightedAgent?: string
  preflight?: typeof preflightDispatchMcp
}): Promise<T> {
  const selected = await input.select()
  if (input.preflightedAgent === selected.agent) return selected
  ;(input.preflight ?? preflightDispatchMcp)({
    mcpRequest: input.mcpRequest,
    cwd: input.cwd,
    job: input.job,
    selectedAgent: selected.agent,
    projectName: input.projectName,
  })
  return selected
}
