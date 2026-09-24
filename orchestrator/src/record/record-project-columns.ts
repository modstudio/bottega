// concern: record-project-columns
/** Maps local project settings onto hosted project columns. Must not know SQL or HTTP. */

export const PROJECT_SETTINGS_NOT_IMPORTED = [
  { key: 'space', reason: "the imported row's space_id carries this value" },
  { key: 'autonomy', reason: 'local-register policy is not carried by the hosted project row' },
  { key: 'checks', reason: 'local-register policy is not carried by the hosted project row' },
] as const

export const PROJECT_SETTING_COLUMNS = {
  color: 'color',
  colorDark: 'color_dark',
  docs: 'docs',
  envPrefix: 'env_prefix',
  gate: 'gate',
  keyPrefixes: 'key_prefixes',
  managedContext: 'managed_context',
  mcp: 'mcp_probe_tool',
  mcpServer: 'mcp_server',
  productionBranch: 'production_branch',
  release: 'release',
  requireCleanMain: 'require_clean_main',
  secretPaths: 'secret_paths',
  states: 'states',
  tracker: 'tracker',
  trunk: 'landing_branch',
  worktree: 'worktree',
  workerMcpServers: 'worker_mcp_servers',
} as const

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
    keyPrefixes: optionalStringArray(settings, 'keyPrefixes', project) ?? [],
    managedContext: settings.managedContext === true,
    landingBranch: optionalString(settings.trunk, `project ${project} settings.trunk`),
    productionBranch: optionalString(
      settings.productionBranch,
      `project ${project} settings.productionBranch`,
    ),
    gate: optionalString(settings.gate, `project ${project} settings.gate`),
    requireCleanMain: settings.requireCleanMain !== false,
    color: optionalString(settings.color, `project ${project} settings.color`),
    colorDark: optionalString(settings.colorDark, `project ${project} settings.colorDark`),
    envPrefix: optionalString(settings.envPrefix, `project ${project} settings.envPrefix`),
    mcpServer: optionalString(settings.mcpServer, `project ${project} settings.mcpServer`),
    workerMcpServers: optionalStringArray(settings, 'workerMcpServers', project),
    secretPaths: optionalStringArray(settings, 'secretPaths', project),
    mcpProbeTool: mcpProbeTool(settings, project),
    docs: document(settings.docs, `project ${project} settings.docs`),
    release: document(settings.release, `project ${project} settings.release`),
    states: document(settings.states, `project ${project} settings.states`),
    tracker: document(settings.tracker, `project ${project} settings.tracker`),
    worktree: document(settings.worktree, `project ${project} settings.worktree`),
  }
}
