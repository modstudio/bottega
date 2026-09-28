// concern: record-project-columns
/** Maps local project settings onto hosted project columns. Must not know SQL or HTTP. */

import type { ProjectSettings } from '../project/project-settings.ts'

export const PROJECT_SETTINGS_NOT_IMPORTED = [
  { key: 'space', reason: "the imported row's space_id carries this value" },
  { key: 'autonomy', reason: 'local-register policy is not carried by the hosted project row' },
  { key: 'checks', reason: 'local-register policy is not carried by the hosted project row' },
  { key: 'search', reason: 'local search policy is not carried by the hosted project row' },
  {
    key: 'canonMirrorKey',
    reason: 'local scheduled-job identity is not carried by the hosted project row',
  },
] as const

export type HostedProjectColumns = {
  keyPrefixes: string[]
  managedContext: boolean
  landingBranch: string | null
  productionBranch: string | null
  gate: string | null
  requireCleanMain: boolean
  color: string | null
  colorDark: string | null
  envPrefix: string | null
  mcpServer: string | null
  workerMcpServers: string[] | null
  secretPaths: string[] | null
  mcpProbeTool: string | null
  docs: string | null
  release: string | null
  states: string | null
  tracker: string | null
  worktree: string | null
}

type HostedSettingKey = Exclude<
  keyof ProjectSettings,
  (typeof PROJECT_SETTINGS_NOT_IMPORTED)[number]['key']
>

export const PROJECT_SETTING_COLUMNS = {
  color: 'color',
  colorDark: 'colorDark',
  docs: 'docs',
  envPrefix: 'envPrefix',
  gate: 'gate',
  keyPrefixes: 'keyPrefixes',
  managedContext: 'managedContext',
  mcp: 'mcpProbeTool',
  mcpServer: 'mcpServer',
  productionBranch: 'productionBranch',
  release: 'release',
  requireCleanMain: 'requireCleanMain',
  secretPaths: 'secretPaths',
  states: 'states',
  tracker: 'tracker',
  trunk: 'landingBranch',
  worktree: 'worktree',
  workerMcpServers: 'workerMcpServers',
} as const satisfies Record<HostedSettingKey, keyof HostedProjectColumns>

type JsonObject = Record<string, unknown>

function object(value: unknown, location: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location} must be a JSON object`)
  }
  return value as JsonObject
}

function optionalString(value: unknown, location: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${location} must be a string`)
  return value
}

function optionalStringArray(
  settings: JsonObject,
  key: 'keyPrefixes' | 'secretPaths' | 'workerMcpServers',
  project: string,
): string[] | null {
  const value = settings[key]
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`project ${project} settings.${key} must be an array of strings`)
  }
  return value as string[]
}

function mcpProbeTool(settings: JsonObject, project: string): string | null {
  if (settings.mcp === undefined || settings.mcp === null) return null
  const mcp = object(settings.mcp, `project ${project} settings.mcp`)
  const unknown = Object.keys(mcp).filter((key) => key !== 'probe_tool')
  if (unknown.length) {
    throw new Error(
      `project ${project} has unmapped settings.mcp keys: ${unknown.sort().join(', ')}`,
    )
  }
  return optionalString(mcp.probe_tool, `project ${project} settings.mcp.probe_tool`)
}

function document(value: unknown, location: string): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(object(value, location))
}

export function hostedProjectColumns(
  settings: Record<string, unknown>,
  project: string,
): HostedProjectColumns {
  const notImported = new Set<string>(PROJECT_SETTINGS_NOT_IMPORTED.map(({ key }) => key))
  const unknown = Object.keys(settings).filter(
    (key) => !notImported.has(key) && !Object.hasOwn(PROJECT_SETTING_COLUMNS, key),
  )
  if (unknown.length) {
    throw new Error(`project ${project} has unmapped settings keys: ${unknown.sort().join(', ')}`)
  }
  return {
    [PROJECT_SETTING_COLUMNS.keyPrefixes]:
      optionalStringArray(settings, 'keyPrefixes', project) ?? [],
    [PROJECT_SETTING_COLUMNS.managedContext]: settings.managedContext === true,
    [PROJECT_SETTING_COLUMNS.trunk]: optionalString(
      settings.trunk,
      `project ${project} settings.trunk`,
    ),
    [PROJECT_SETTING_COLUMNS.productionBranch]: optionalString(
      settings.productionBranch,
      `project ${project} settings.productionBranch`,
    ),
    [PROJECT_SETTING_COLUMNS.gate]: optionalString(
      settings.gate,
      `project ${project} settings.gate`,
    ),
    [PROJECT_SETTING_COLUMNS.requireCleanMain]: settings.requireCleanMain !== false,
    [PROJECT_SETTING_COLUMNS.color]: optionalString(
      settings.color,
      `project ${project} settings.color`,
    ),
    [PROJECT_SETTING_COLUMNS.colorDark]: optionalString(
      settings.colorDark,
      `project ${project} settings.colorDark`,
    ),
    [PROJECT_SETTING_COLUMNS.envPrefix]: optionalString(
      settings.envPrefix,
      `project ${project} settings.envPrefix`,
    ),
    [PROJECT_SETTING_COLUMNS.mcpServer]: optionalString(
      settings.mcpServer,
      `project ${project} settings.mcpServer`,
    ),
    [PROJECT_SETTING_COLUMNS.workerMcpServers]: optionalStringArray(
      settings,
      'workerMcpServers',
      project,
    ),
    [PROJECT_SETTING_COLUMNS.secretPaths]: optionalStringArray(settings, 'secretPaths', project),
    [PROJECT_SETTING_COLUMNS.mcp]: mcpProbeTool(settings, project),
    [PROJECT_SETTING_COLUMNS.docs]: document(settings.docs, `project ${project} settings.docs`),
    [PROJECT_SETTING_COLUMNS.release]: document(
      settings.release,
      `project ${project} settings.release`,
    ),
    [PROJECT_SETTING_COLUMNS.states]: document(
      settings.states,
      `project ${project} settings.states`,
    ),
    [PROJECT_SETTING_COLUMNS.tracker]: document(
      settings.tracker,
      `project ${project} settings.tracker`,
    ),
    [PROJECT_SETTING_COLUMNS.worktree]: document(
      settings.worktree,
      `project ${project} settings.worktree`,
    ),
  }
}
