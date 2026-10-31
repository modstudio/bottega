// concern: Codex ask-tool exposure observation
/**
 * Knows the observed Codex rollout tool-list shape and how to read the newest
 * rollout in one run-scoped home. Must not know run lifecycle or persistence.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { codexMcpToolIdentifier } from '../contract/codex-mcp-tool.ts'

type CodexAskExposureSurface = 'top-level' | 'code-mode' | 'absent' | 'unknown'
export type CodexAskExposure = {
  surface: CodexAskExposureSurface
  cliVersion: string | null
}

type Tool = { name?: unknown; tools?: unknown }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function namedTools(value: unknown): Tool[] {
  return Array.isArray(value) ? value.filter((tool) => record(tool)) : []
}

/** Classify ask-tool exposure from Codex rollout JSONL without assuming malformed input is absent. */
export function parseCodexAskExposure(text: string | null | undefined): CodexAskExposure {
  let cliVersion: string | null = null
  let recognized = false
  let topLevel = false
  let codeMode = false
  const nestedRunTests = codexMcpToolIdentifier(WORKER_MCP_SERVER_NAME, 'run_tests')
  for (const line of text?.split('\n') ?? []) {
    let item: Record<string, unknown> | null = null
    try {
      item = record(JSON.parse(line))
    } catch {
      continue
    }
    const payload = record(item?.payload)
    if (item?.type === 'session_meta' && typeof payload?.cli_version === 'string') {
      cliVersion = payload.cli_version
    }
    if (item?.type !== 'response_item' || payload?.type !== 'additional_tools') continue
    if (!Array.isArray(payload.tools)) continue
    recognized = true
    for (const namespace of namedTools(payload.tools)) {
      if (namespace.name === 'run_tests' || namespace.name === nestedRunTests) topLevel = true
      const tools = namedTools(namespace.tools)
      if (tools.some((tool) => tool.name === 'run_tests' || tool.name === nestedRunTests)) {
        topLevel = true
      }
      if (namespace.name === 'functions' && tools.some((tool) => tool.name === 'exec')) {
        codeMode = true
      }
    }
  }
  return {
    surface: !recognized ? 'unknown' : topLevel ? 'top-level' : codeMode ? 'code-mode' : 'absent',
    cliVersion,
  }
}

function newestRollout(home: string | undefined): string | null {
  if (!home) return null
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) return null
  try {
    const root = realpathSync(home)
    const candidates = [...new Bun.Glob('**/rollout-*.jsonl').scanSync({ cwd: sessions })]
      .flatMap((relative) => {
        const path = join(sessions, relative)
        const entry = lstatSync(path, { throwIfNoEntry: false })
        if (!entry?.isFile() || entry.isSymbolicLink()) return []
        const resolved = realpathSync(path)
        return resolved.startsWith(root + sep) ? [resolved] : []
      })
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    return candidates[0] ?? null
  } catch {
    return null
  }
}

/** Read the newest rollout in a run-scoped Codex home; all failures classify as unknown. */
export function codexAskExposureFromHome(home: string | undefined): CodexAskExposure {
  const rollout = newestRollout(home)
  if (!rollout) return parseCodexAskExposure(null)
  try {
    return parseCodexAskExposure(readFileSync(rollout, 'utf8'))
  } catch {
    return parseCodexAskExposure(null)
  }
}
