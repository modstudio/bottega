// concern: read the orch-ask command exactly as configured for a vendor turn
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function tomlJsonValue(section: string, key: string): unknown {
  const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'))
  if (!match) return undefined
  return JSON.parse(match[1]!)
}

export function grokAskCommandFromConfig(config: string): string[] {
  const start = config.search(/^\s*\[mcp_servers\.orch-ask\]\s*$/m)
  if (start < 0) throw new Error('Grok config has no mcp_servers.orch-ask table')
  const afterHeader = config.indexOf('\n', start)
  const rest = afterHeader < 0 ? '' : config.slice(afterHeader + 1)
  const nextTable = rest.search(/^\s*\[/m)
  const section = nextTable < 0 ? rest : rest.slice(0, nextTable)
  const command = tomlJsonValue(section, 'command')
  const args = tomlJsonValue(section, 'args') ?? []
  if (
    typeof command !== 'string' ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== 'string')
  ) {
    throw new Error('Grok orch-ask command or args are malformed')
  }
  return [command, ...args]
}

export function grokAskCommandFromEnvironment(environment: Record<string, string>): string[] {
  const home = environment.GROK_HOME
  if (!home) throw new Error('Grok turn has no configured MCP home')
  return grokAskCommandFromConfig(readFileSync(join(home, 'config.toml'), 'utf8'))
}
