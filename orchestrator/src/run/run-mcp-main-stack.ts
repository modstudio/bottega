// concern: MCP run main-stack preflight

import type { McpConnection, McpRequest } from '../mcp/mcp-preflight.ts'
import { probeRequestedMcp, requestedMcpMode } from '../mcp/mcp-preflight.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { ensureProjectMainStack } from '../resources/main-stack.ts'
import { shouldDeferCwdMcpPreflight } from './run-mcp-attachment.ts'

export function prepareRunMcpPreflight(input: {
  mcpRequest: McpRequest | undefined
  callerCwd: string
  projectName?: string
  forbidsRepo: boolean
  repoJob: boolean
  discoversMcpFromCwd: boolean
  agent: string
}): { deferredCwdMcpPreflight: boolean; mcpConnection: McpConnection | null } {
  const cwdProject = projectAt(input.callerCwd)
  const project = input.projectName ? projectByName(input.projectName) : cwdProject
  const deferredCwdMcpPreflight = shouldDeferCwdMcpPreflight({
    mcpRequest: input.mcpRequest,
    callerCwdHasProject: Boolean(cwdProject),
    forbidsRepo: input.forbidsRepo,
    repoJob: input.repoJob,
    discoversMcpFromCwd: input.discoversMcpFromCwd,
  })
  if (!deferredCwdMcpPreflight && requestedMcpMode(input.mcpRequest) && project) {
    ensureProjectMainStack(project, 'mcp')
  }
  return {
    deferredCwdMcpPreflight,
    mcpConnection: deferredCwdMcpPreflight
      ? null
      : probeRequestedMcp(input.mcpRequest, input.agent, input.callerCwd),
  }
}

export function ensureDispatchMcpMainStack(input: {
  mcpRequest: McpRequest
  cwd: string
  projectName?: string
}): void {
  const project = input.projectName ? projectByName(input.projectName) : projectAt(input.cwd)
  if (project) ensureProjectMainStack(project, 'mcp')
}
