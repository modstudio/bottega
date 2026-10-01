#!/usr/bin/env bun
/**
 * Live, operator-run evidence for the external tracker MCP dialects hub consumes.
 * This deliberately stays outside the gate: it reaches real services with credentials.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { concernStateDirectory } from '../../shared/state-directory.ts'
import { type TrackerProtocol, trackerWireAction } from '../../shared/trackers.ts'
import { credentials, MCP_PROTOCOL_VERSION, Mcp, type McpExchange } from '../src/mcp.ts'
import { projects, type RegisteredProject } from '../src/projects.ts'

const TARGETS = [
  { project: 'adanim', protocol: 'array-mcp' },
  { project: 'starship', protocol: 'workspace-mcp' },
  { project: 'alephbeis', protocol: 'workspace-mcp' },
  { project: 'stopal', protocol: 'cursor-mcp' },
] as const satisfies readonly { project: string; protocol: TrackerProtocol }[]

type Target = (typeof TARGETS)[number]
type DialectResult = {
  project: string
  protocol: Target['protocol']
  requestedProtocolVersion: string
  answeredProtocolVersion: string | null
  tool: string
  toolCallSucceeded: boolean
  failure: 'credentials did not resolve' | 'initialize or tool call failed' | null
  exchanges: McpExchange[]
}

function trackerEnvironment(project: RegisteredProject, target: Target): string {
  const tracker = project.settings.tracker
  if (tracker?.protocol !== target.protocol) {
    throw new Error(
      `project ${target.project} must declare tracker protocol ${target.protocol}; found ${tracker?.protocol ?? '(missing)'}`,
    )
  }
  const prefix = tracker.envPrefix ?? project.settings.envPrefix
  if (!prefix) throw new Error(`project ${target.project} tracker is missing envPrefix`)
  return prefix
}

function readOnlyCall(project: RegisteredProject, protocol: Target['protocol']) {
  const status = project.settings.tracker?.openStatuses?.[0]
  if (!status) throw new Error(`project ${project.name} tracker has no open status for a read`)
  const tool = trackerWireAction(protocol, 'search')
  if (protocol === 'workspace-mcp') return { tool, args: { status, page: 1, per_page: 1 } }
  if (protocol === 'cursor-mcp') return { tool, args: { status, limit: 1 } }
  return { tool, args: { status } }
}

async function inspect(
  target: Target,
  registered: RegisteredProject[],
  requestProtocolVersion: string,
): Promise<DialectResult> {
  const project = registered.find((candidate) => candidate.name === target.project)
  if (!project) throw new Error(`project ${target.project} is absent from the register`)
  const env = trackerEnvironment(project, target)
  const call = readOnlyCall(project, target.protocol)
  const exchanges: McpExchange[] = []
  const auth = await credentials(env)
  if (!auth) {
    return {
      project: target.project,
      protocol: target.protocol,
      requestedProtocolVersion: requestProtocolVersion,
      answeredProtocolVersion: null,
      tool: call.tool,
      toolCallSucceeded: false,
      failure: 'credentials did not resolve',
      exchanges,
    }
  }
  const client = new Mcp(
    auth.url,
    auth.token,
    30_000,
    (exchange) => exchanges.push(exchange),
    requestProtocolVersion,
  )
  try {
    await client.initialize()
    await client.callTool(call.tool, call.args)
    return {
      project: target.project,
      protocol: target.protocol,
      requestedProtocolVersion: requestProtocolVersion,
      answeredProtocolVersion:
        exchanges.find((exchange) => exchange.method === 'initialize')?.answeredProtocolVersion ??
        null,
      tool: call.tool,
      toolCallSucceeded: true,
      failure: null,
      exchanges,
    }
  } catch {
    return {
      project: target.project,
      protocol: target.protocol,
      requestedProtocolVersion: requestProtocolVersion,
      answeredProtocolVersion:
        exchanges.find((exchange) => exchange.method === 'initialize')?.answeredProtocolVersion ??
        null,
      tool: call.tool,
      toolCallSucceeded: false,
      failure: 'initialize or tool call failed',
      exchanges,
    }
  } finally {
    await client.close()
  }
}

async function main(): Promise<void> {
  const requestProtocolVersion = parseRequestProtocolVersion(process.argv.slice(2))
  const registered = projects()
  const dialects = await Promise.all(
    TARGETS.map((target) => inspect(target, registered, requestProtocolVersion)),
  )
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: 'DEV-1034 live outbound MCP dialect evidence',
    dialects,
  }
  const text = `${JSON.stringify(report, null, 2)}\n`
  const directory = concernStateDirectory('hub', process.env)
  const path = join(directory, 'mcp-dialect-evidence.json')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
  process.stdout.write(text)
  if (dialects.some((dialect) => !dialect.toolCallSucceeded)) process.exitCode = 1
}

function parseRequestProtocolVersion(argv: string[]): string {
  if (argv.length === 0) return MCP_PROTOCOL_VERSION
  if (argv.length !== 2 || argv[0] !== '--request-version') {
    throw new Error('usage: mcp-dialect-evidence.ts [--request-version YYYY-MM-DD]')
  }
  const version = argv[1]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) {
    throw new Error('--request-version must be a date-shaped version string (YYYY-MM-DD)')
  }
  return version
}

await main()
