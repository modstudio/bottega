// concern: project-mcp-scope
/**
 * Names the project MCP servers one run attaches and how. Harness-neutral: it
 * must not know argv, transports, or credentials.
 */
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveProjectMcpCommand } from '../mcp/mcp-command.ts'
import {
  disabledProjectMcpServers,
  type McpConfigReadResult,
  type McpServerConfig,
} from '../mcp/mcp-probe.ts'
import {
  mcpConfigReadForRun,
  isProjectRelativeStdioServer,
  type ProjectMcpWithheld,
  projectProxyServers,
  projectReaderProxyServers,
  READER_PLATFORM_MCP_SERVERS,
  type ReaderProxyServer,
} from './mcp-reader-scope.ts'

export type { ProjectMcpWithheld }

export const PROJECT_MCP_WRITER_WITHHELD_REASON =
  'inline env/headers, a headersHelper, or no launch definition'

export const PROJECT_MCP_WRITER_WITHHELD_ADVICE =
  'writing workers cannot receive these; run as a reader through the proxy, or declare the server without them'

export const PROJECT_MCP_WRITER_TOOLS_ADVICE = `declare mcp.writer_tools.<server> with ${PLATFORM_SLUG} project update`

export const PROJECT_MCP_ACP_WRITER_ADVICE =
  'ACP writers do not receive proxied project servers yet'

export const PROJECT_MCP_RELATIVE_WRITER_REASON =
  "its project-relative command would run a worker-writable path with the project's credentials"

export const PROJECT_MCP_RELATIVE_WRITER_ADVICE =
  'use a bare command name or an absolute path in .mcp.json'

/** The edit that clears a writer withhold: the tree entry, or the project's named server. */
export function projectMcpWriterRemedy(project: { name: string; path: string } | null): string {
  const configPath = project ? join(project.path, '.mcp.json') : '.mcp.json'
  const projectName = project?.name ?? '<project>'
  return `the server's entry in ${configPath}, or by naming the server this project provides with ${PLATFORM_SLUG} project set ${projectName} --settings '{"mcpServer":"<server>"}'`
}

/**
 * The platform's own MCP identities. A project configuration never occupies
 * them: a project server named like the worker channel could shadow it.
 */
function withoutPlatformServers(read: McpConfigReadResult): McpConfigReadResult {
  if (!read.ok) return read
  const platform = new Set<string>(READER_PLATFORM_MCP_SERVERS)
  return {
    ...read,
    config: Object.fromEntries(Object.entries(read.config).filter(([name]) => !platform.has(name))),
  }
}

/** A project server launchable without inline credentials: a command or a url. */
export type ProjectMcpServer = { command: string; args: string[]; cwd: string } | { url: string }

export type WriterProxyDecision = { kind: 'proxy' } | { kind: 'withhold'; advice: string }

export type ProjectMcpProject = {
  name: string
  path: string
  settings: {
    workerMcpServers?: string[]
    mcpServer?: string
    mcp?: { writer_tools?: Record<string, string[]> }
  }
}

/** Whether a writer must withhold one project server instead of attaching it directly. */
function projectMcpWriterWithholds(config: McpServerConfig): boolean {
  return Boolean(
    Object.keys(config.env ?? {}).length ||
      Object.keys(config.headers ?? {}).length ||
      config.headersHelper ||
      (!config.url && !config.command),
  )
}

/** Which project servers attach to one run, and how a harness must reach them. */
export type ProjectMcpSelection =
  | { kind: 'reader'; servers: Record<string, ReaderProxyServer>; withheld: ProjectMcpWithheld[] }
  | {
      kind: 'direct'
      servers: Record<string, ProjectMcpServer | ReaderProxyServer>
      withheld: ProjectMcpWithheld[]
    }

/** Select project MCP launch definitions that are safe to expose without inline credentials. */
function writerWithheld(
  name: string,
  project: { name: string; path: string } | null,
  advice = PROJECT_MCP_WRITER_WITHHELD_ADVICE,
  reason = PROJECT_MCP_WRITER_WITHHELD_REASON,
): ProjectMcpWithheld {
  return {
    name,
    reason,
    advice,
    remedy: projectMcpWriterRemedy(project),
  }
}

type CredentialedWriterRoute =
  | { kind: 'proxy'; projectName: string }
  | { kind: 'withheld'; advice: string }

/** Decide whether one credentialed writer route is proxied or visibly withheld. */
function decideCredentialedWriterRoute(input: {
  writerProxy: WriterProxyDecision
  writerTools: readonly string[]
  projectName: string | null
  server: string
}): CredentialedWriterRoute {
  if (input.writerProxy.kind === 'withhold') {
    return { kind: 'withheld', advice: input.writerProxy.advice }
  }
  if (input.writerTools.length > 0 && input.projectName) {
    return { kind: 'proxy', projectName: input.projectName }
  }
  return {
    kind: 'withheld',
    advice: PROJECT_MCP_WRITER_TOOLS_ADVICE.replace('<server>', input.server),
  }
}

/** Refuse a required writing route when its project server cannot enter the worker scope. */
export function requiredProjectMcpWriterIneligibility(
  server: string,
  mode: 'require' | 'prefer',
  writesRepository: boolean,
  config: McpServerConfig | undefined,
  project: ProjectMcpProject | null,
  writerProxy: WriterProxyDecision,
): string | null {
  if (mode !== 'require' || !writesRepository || !config || !projectMcpWriterWithholds(config))
    return null
  const registered = project?.settings.mcp?.writer_tools?.[server] ?? []
  const route = decideCredentialedWriterRoute({
    writerProxy,
    writerTools: registered,
    projectName: project?.name ?? null,
    server,
  })
  if (route.kind === 'proxy') return null
  const withheld = writerWithheld(server, project, route.advice)
  return (
    `required project MCP server '${server}' is withheld from writing workers ` +
    `(${withheld.reason}); ${withheld.advice}; cleared by: ${withheld.remedy}`
  )
}

function selectDirectProjectMcpServers(
  read: McpConfigReadResult,
  allowed: string[] | undefined,
  cwd: string,
  project: ProjectMcpProject | null,
  writerProxy: WriterProxyDecision,
): Extract<ProjectMcpSelection, { kind: 'direct' }> {
  const projectRead = withoutPlatformServers(read)
  const projectServers = projectRead.ok ? projectRead.config : {}
  const disabled = new Set(disabledProjectMcpServers(Object.keys(projectServers), allowed))
  const servers: Record<string, ProjectMcpServer | ReaderProxyServer> = {}
  const withheld: ProjectMcpWithheld[] = []
  for (const [name, entry] of Object.entries(projectServers)) {
    if (disabled.has(name)) continue
    if (projectMcpWriterWithholds(entry)) {
      if (isProjectRelativeStdioServer(entry)) {
        withheld.push(
          writerWithheld(
            name,
            project,
            PROJECT_MCP_RELATIVE_WRITER_ADVICE,
            PROJECT_MCP_RELATIVE_WRITER_REASON,
          ),
        )
        continue
      }
      const writerTools = project?.settings.mcp?.writer_tools?.[name] ?? []
      const route = decideCredentialedWriterRoute({
        writerProxy,
        writerTools,
        projectName: project?.name ?? null,
        server: name,
      })
      if (route.kind === 'proxy') {
        const proxy = projectProxyServers([name], 'writer', route.projectName, cwd)[name]
        if (proxy) servers[name] = proxy
      } else {
        withheld.push(writerWithheld(name, project, route.advice))
      }
    } else if (entry.url) {
      servers[name] = { url: entry.url }
    } else if (entry.command) {
      const command = resolveProjectMcpCommand(entry.command, cwd)
      servers[name] = { command, args: entry.args ?? [], cwd }
    }
  }
  return { kind: 'direct', servers, withheld }
}

/**
 * Decide which project servers one run attaches. A reading run reaches them
 * through the credential-free reader proxy; a writing run attaches them
 * directly; the run's allowlist applies to both.
 */
export function selectProjectMcpServers(
  mcp: false | 'reader' | 'writer',
  treeConfig: Record<string, McpServerConfig>,
  project: ProjectMcpProject | null,
  cwd: string,
  hasProjectTree: boolean,
  writerProxy: WriterProxyDecision,
): ProjectMcpSelection | null {
  if (mcp === false) return null
  const read = mcpConfigReadForRun(treeConfig, project, cwd)
  if (mcp === 'writer')
    return selectDirectProjectMcpServers(
      read,
      project?.settings.workerMcpServers,
      cwd,
      project,
      writerProxy,
    )
  return {
    kind: 'reader',
    ...projectReaderProxyServers(withoutPlatformServers(read), project, cwd, hasProjectTree),
  }
}

/** The visible reason one harness does not have a withheld project server. */
export function projectMcpWithheldLine(
  harness: string,
  withheld: ProjectMcpWithheld[],
): string | null {
  if (!withheld.length) return null
  const names = withheld.map((entry) => entry.name).join(', ')
  const reasons = [...new Set(withheld.map((entry) => entry.reason))]
  if (reasons.length === 1) {
    const head = `MCP scope: ${harness} withheld ${names} (${reasons[0]})`
    const uniqueAdvice = [...new Set(withheld.map((entry) => entry.advice ?? ''))]
    if (uniqueAdvice.length === 1) return uniqueAdvice[0] ? `${head}; ${uniqueAdvice[0]}` : head
  }
  return `MCP scope: ${harness} withheld ${withheld
    .map((entry) => `${entry.name} (${entry.reason}${entry.advice ? `; ${entry.advice}` : ''})`)
    .join(', ')}`
}

/**
 * Append an already-rendered scope line to a setup header. Whether a harness
 * needs the line is its caller's decision, not this module's.
 */
export function mergeMcpSetupHeader(header: string | null, line: string | null): string | null {
  if (!line) return header
  return header ? `${header}\n${line}` : line
}
