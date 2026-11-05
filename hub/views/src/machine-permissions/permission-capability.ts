import { PLATFORM_SLUG } from '../../../../shared/brand.ts'
/** A capability an agent permission belongs to, named for a reader rather than a harness. */
export type Capability = { id: string; label: string; hint: string }

const CAPABILITIES = {
  files: { id: 'files', label: 'Files', hint: 'Reading, finding and changing files.' },
  shell: {
    id: 'shell',
    label: 'Shell tools',
    hint: 'Everyday commands that inspect text and folders.',
  },
  delete: { id: 'delete', label: 'Deleting', hint: 'Removing files and folders.' },
  git: { id: 'git', label: 'Git', hint: 'Commits, branches and pushes.' },
  github: { id: 'github', label: 'GitHub', hint: 'Pull requests and workflow runs.' },
  build: { id: 'build', label: 'Build and test', hint: 'Package managers, scripts and tests.' },
  data: { id: 'data', label: 'Databases', hint: 'Queries against local and remote databases.' },
  deploy: {
    id: 'deploy',
    label: 'Servers and deploys',
    hint: 'Containers, hosting, cloud storage and remote machines.',
  },
  agents: { id: 'agents', label: 'Agents', hint: 'Other agents and the tools that run them.' },
  web: { id: 'web', label: 'Web', hint: 'Fetching pages and searching the internet.' },
  connected: {
    id: 'connected',
    label: 'Connected tools',
    hint: 'Tools served by connected servers.',
  },
  other: { id: 'other', label: 'Other', hint: 'Rules that fit no other group.' },
} as const satisfies Record<string, Capability>

/** The order groups are shown in. */
export const CAPABILITY_ORDER: readonly Capability[] = Object.values(CAPABILITIES)

const SHELL_TOOLS = new Set([
  'awk',
  'basename',
  'cat',
  'cd',
  'cut',
  'diff',
  'dirname',
  'file',
  'find',
  'grep',
  'head',
  'ls',
  'pwd',
  'readlink',
  'realpath',
  'sed',
  'sort',
  'stat',
  'tail',
  'tr',
  'tree',
  'uniq',
  'wc',
  'which',
  'xargs',
])
const BUILD_TOOLS = new Set(['bun', 'bunx', 'npm', 'npx', 'node', 'python3', 'php', 'chmod', 'tar'])
const DATA_TOOLS = new Set(['psql', 'sqlite3', 'mysql', 'redis-cli'])
const DEPLOY_TOOLS = new Set(['docker', 'fly', 'flyctl', 'aws', 'ssh', 'bash', 'curl', 'kubectl'])
const AGENT_TOOLS = new Set(['agy', 'claude', 'codex', 'grok', PLATFORM_SLUG])
const DELETE_TOOLS = new Set(['rm', 'rmdir'])

/** The tool a rule names and what it is limited to: `Bash(git push:*)` is `Bash` and `git push:*`. */
function parts(rule: string) {
  const open = rule.indexOf('(')
  if (open < 0 || !rule.endsWith(')')) return { tool: rule, pattern: '' }
  return { tool: rule.slice(0, open), pattern: rule.slice(open + 1, -1) }
}

/** The command a shell rule matches, without its trailing wildcard. */
function commandOf(pattern: string) {
  return pattern.replace(/:\*$/, '').replace(/ ?\*$/, '').trim()
}

function programOf(command: string) {
  const first = command.split(/\s+/)[0] ?? ''
  return first.split('/').pop() ?? first
}

function shellCapability(command: string): Capability {
  const program = programOf(command)
  if (DELETE_TOOLS.has(program)) return CAPABILITIES.delete
  if (program === 'git') return CAPABILITIES.git
  if (program === 'gh') return CAPABILITIES.github
  if (SHELL_TOOLS.has(program)) return CAPABILITIES.shell
  if (BUILD_TOOLS.has(program)) return CAPABILITIES.build
  if (DATA_TOOLS.has(program)) return CAPABILITIES.data
  if (DEPLOY_TOOLS.has(program)) return CAPABILITIES.deploy
  if (AGENT_TOOLS.has(program)) return CAPABILITIES.agents
  return CAPABILITIES.other
}

const FILE_TOOLS: Record<string, string> = {
  Read: 'Read',
  Edit: 'Edit',
  Write: 'Write',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit notebooks in',
  Glob: 'Find files by name in',
  Grep: 'Search the contents of',
}

/** Where a path pattern reaches, in words: `//Users/x` is an absolute path, `~/a/*` a folder. */
function placeOf(pattern: string) {
  const path = pattern.startsWith('//') ? pattern.slice(1) : pattern
  return path.replace(/\/\*\*?$/, '')
}

function fileLabel(tool: string, pattern: string) {
  const verb = FILE_TOOLS[tool] ?? tool
  if (!pattern) {
    if (tool === 'Glob') return 'Find files by name'
    if (tool === 'Grep') return 'Search file contents'
    return `${verb} any file`
  }
  const place = placeOf(pattern)
  const folder = pattern.endsWith('*')
  if (tool === 'Glob' || tool === 'Grep' || tool === 'NotebookEdit') return `${verb} ${place}`
  return folder ? `${verb} files in ${place}` : `${verb} ${place}`
}

function connectedLabel(rule: string) {
  const [, server = '', ...tool] = rule.split('__')
  const name = server.replace(/^plugin_[^_]+_/, '')
  const rest = tool.join('__')
  if (!rest || rest === '*') return `Use any ${name} tool`
  if (rest.endsWith('*')) return `Use ${name} tools starting ${rest.slice(0, -1)}`
  return `Use the ${name} tool ${rest}`
}

function webLabel(tool: string, pattern: string) {
  if (tool === 'WebSearch') return 'Search the web'
  if (pattern.startsWith('domain:')) return `Fetch pages from ${pattern.slice('domain:'.length)}`
  return 'Fetch any web page'
}

export type ReadablePermission = { capability: Capability; label: string }

/** A permission rule in words, with the capability it is grouped under. */
export function readablePermission(rule: string): ReadablePermission {
  if (rule.startsWith('mcp__'))
    return { capability: CAPABILITIES.connected, label: connectedLabel(rule) }
  const { tool, pattern } = parts(rule)
  if (tool === 'Bash') {
    const command = commandOf(pattern)
    const wildcard = pattern !== command
    return {
      capability: shellCapability(command),
      label: command ? `Run ${command}${wildcard ? ' …' : ''}` : 'Run any command',
    }
  }
  if (tool in FILE_TOOLS) return { capability: CAPABILITIES.files, label: fileLabel(tool, pattern) }
  if (tool === 'WebFetch' || tool === 'WebSearch')
    return { capability: CAPABILITIES.web, label: webLabel(tool, pattern) }
  return { capability: CAPABILITIES.other, label: pattern ? `${tool} ${pattern}` : tool }
}
