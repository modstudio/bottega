// concern: harness install prerequisites
/** Owns harness install prerequisite facts, decisions, and operator notices. */

import { which } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  HARNESS_MCP_CATALOGUE,
  type HarnessInstallRequirement,
  type HarnessInstallRoute,
  type HarnessName,
  harnessCatalogueName,
  harnessInstallRoute,
} from './setup-mcp.ts'

type HarnessAgent = { name: string; harness: string; enabled: number | boolean }

export function neededHarnesses(
  agents: readonly HarnessAgent[],
): Array<{ harness: HarnessName; agents: string[] }> {
  const names = new Map<HarnessName, string[]>()
  for (const agent of agents) {
    if (!agent.enabled) continue
    const candidate =
      agent.name === 'codex' || agent.name === 'grok'
        ? agent.name
        : harnessCatalogueName(agent.harness)
    if (!candidate) continue
    const agentNames = names.get(candidate) ?? []
    agentNames.push(agent.name)
    names.set(candidate, agentNames)
  }
  return [...names].map(([harness, harnessAgents]) => ({ harness, agents: harnessAgents }))
}

export function harnessInstallPrerequisiteAvailability(
  platform: NodeJS.Platform,
  lookup: (command: string) => string | null = (command) =>
    which(command, { PATH: process.env.PATH }),
): Record<string, boolean> {
  const commands = new Set<string>()
  for (const harness of Object.keys(HARNESS_MCP_CATALOGUE) as HarnessName[]) {
    for (const requirement of harnessInstallRoute(harness, platform)?.requires ?? []) {
      commands.add(requirement.command)
    }
  }
  return Object.fromEntries([...commands].map((command) => [command, lookup(command) !== null]))
}

export function missingHarnessInstallPrerequisites(
  route: HarnessInstallRoute,
  available: Readonly<Record<string, boolean>>,
): HarnessInstallRequirement[] {
  return (route.requires ?? []).filter(({ command }) => available[command] === false)
}

export function harnessInstallPrerequisiteNotice(
  harness: HarnessName,
  agentNames: readonly string[],
  missing: readonly HarnessInstallRequirement[],
): { message: string; fix: string; blocking: false } {
  return {
    message: `${harness} is needed by enabled agent(s) ${agentNames.join(', ')}, but its install route needs ${missing.map(({ command }) => command).join(', ')}, which is not installed`,
    fix: `sudo apt-get install -y ${missing.map(({ aptPackage }) => aptPackage).join(' ')}, then rerun ${PLATFORM_SLUG} machine setup plan`,
    blocking: false,
  }
}
