// concern: record-project-columns
/** Maps local project settings onto hosted project columns. Must not know SQL or HTTP. */

import type { ProjectSettings } from '../project/project-settings.ts'
import type { RepositoryVisibility } from '../project/project-visibility.ts'

export const PROJECT_SETTINGS_NOT_IMPORTED = [
  { key: 'space', reason: "the imported row's space_id carries this value" },
  { key: 'autonomy', reason: 'local-register policy is not carried by the hosted project row' },
  { key: 'checks', reason: 'local-register policy is not carried by the hosted project row' },
  { key: 'search', reason: 'local search policy is not carried by the hosted project row' },
  {
    key: 'mainStack',
    reason: 'machine-local stack policy is not carried by the hosted project row',
  },
  {
    key: 'canonMirrorKey',
    reason: 'local scheduled-job identity is not carried by the hosted project row',
  },
  {
    key: 'visibilityRepository',
    reason: 'the verified identity belongs to the local registered checkout origin',
  },
] as const

export type HostedProjectColumns = {
  visibility: RepositoryVisibility | null
  keyPrefixes: string[]
  managedContext: boolean
  landingBranch: string | null
  productionBranch: string | null
  gate: string | null
  focusedTests: JsonObject | null
  requireCleanMain: boolean
  color: string | null
  colorDark: string | null
  envPrefix: string | null
  mcpServer: string | null
  workerMcpServers: string[] | null
  secretPaths: string[] | null
  mcpProbeTool: string | null
  mcpReaderTools: JsonObject | null
  docs: JsonObject | null
  reference: JsonObject | null
  signals: JsonObject | null
  review: JsonObject | null
  testSubstance: JsonObject | null
  mechanicalChecks: JsonObject | null
  release: JsonObject | null
  states: JsonObject | null
  tracker: JsonObject | null
  worktree: JsonObject | null
}

type HostedSettingKey = Exclude<
  keyof ProjectSettings,
  (typeof PROJECT_SETTINGS_NOT_IMPORTED)[number]['key']
>

export const PROJECT_SETTING_COLUMNS = {
  visibility: 'visibility',
  color: 'color',
  colorDark: 'colorDark',
  docs: 'docs',
  envPrefix: 'envPrefix',
  gate: 'gate',
  focusedTests: 'focusedTests',
  keyPrefixes: 'keyPrefixes',
  managedContext: 'managedContext',
  mcp: 'mcpProbeTool',
  mcpServer: 'mcpServer',
  productionBranch: 'productionBranch',
  reference: 'reference',
  release: 'release',
  requireCleanMain: 'requireCleanMain',
  secretPaths: 'secretPaths',
  signals: 'signals',
  review: 'review',
  testSubstance: 'testSubstance',
  mechanicalChecks: 'mechanicalChecks',
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

function optionalVisibility(value: unknown, project: string): RepositoryVisibility | null {
  if (value === undefined || value === null) return null
  if (value === 'public' || value === 'private') return value
  throw new Error(`project ${project} settings.visibility must be public or private`)
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
  const unknown = Object.keys(mcp).filter((key) => key !== 'probe_tool' && key !== 'reader_tools')
  if (unknown.length) {
    throw new Error(
      `project ${project} has unmapped settings.mcp keys: ${unknown.sort().join(', ')}`,
    )
  }
  return optionalString(mcp.probe_tool, `project ${project} settings.mcp.probe_tool`)
}

function mcpReaderTools(settings: JsonObject, project: string): JsonObject | null {
  if (settings.mcp === undefined || settings.mcp === null) return null
  const mcp = object(settings.mcp, `project ${project} settings.mcp`)
  return document(mcp.reader_tools, `project ${project} settings.mcp.reader_tools`)
}

function document(value: unknown, location: string): JsonObject | null {
  if (value === undefined || value === null) return null
  return object(value, location)
}

function settingDocument(settings: JsonObject, key: string, project: string): JsonObject | null {
  return document(settings[key], `project ${project} settings.${key}`)
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
    [PROJECT_SETTING_COLUMNS.visibility]: optionalVisibility(settings.visibility, project),
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
    [PROJECT_SETTING_COLUMNS.focusedTests]: settingDocument(settings, 'focusedTests', project),
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
    mcpReaderTools: mcpReaderTools(settings, project),
    [PROJECT_SETTING_COLUMNS.docs]: settingDocument(settings, 'docs', project),
    [PROJECT_SETTING_COLUMNS.reference]: settingDocument(settings, 'reference', project),
    [PROJECT_SETTING_COLUMNS.signals]: settingDocument(settings, 'signals', project),
    [PROJECT_SETTING_COLUMNS.review]: settingDocument(settings, 'review', project),
    [PROJECT_SETTING_COLUMNS.testSubstance]: settingDocument(settings, 'testSubstance', project),
    [PROJECT_SETTING_COLUMNS.mechanicalChecks]: settingDocument(
      settings,
      'mechanicalChecks',
      project,
    ),
    [PROJECT_SETTING_COLUMNS.release]: settingDocument(settings, 'release', project),
    [PROJECT_SETTING_COLUMNS.states]: settingDocument(settings, 'states', project),
    [PROJECT_SETTING_COLUMNS.tracker]: settingDocument(settings, 'tracker', project),
    [PROJECT_SETTING_COLUMNS.worktree]: settingDocument(settings, 'worktree', project),
  }
}

function omitHostedSetting(setting: string, value: unknown): boolean {
  if (setting === 'mcp' || value === null) return true
  if (setting === 'keyPrefixes' && Array.isArray(value) && value.length === 0) return true
  if (setting === 'managedContext' && value === false) return true
  return setting === 'requireCleanMain' && value === true
}

export function hostedProjectSettings(columns: HostedProjectColumns): ProjectSettings {
  const settings: Record<string, unknown> = {}
  for (const [setting, column] of Object.entries(PROJECT_SETTING_COLUMNS)) {
    const value = columns[column as keyof HostedProjectColumns]
    if (!omitHostedSetting(setting, value)) settings[setting] = value
  }
  const probeTool = columns.mcpProbeTool
  const readerTools = columns.mcpReaderTools
  if (probeTool !== null || readerTools !== null) {
    settings.mcp = {
      ...(probeTool === null ? {} : { probe_tool: probeTool }),
      ...(readerTools === null ? {} : { reader_tools: readerTools }),
    }
  }
  return settings as ProjectSettings
}
