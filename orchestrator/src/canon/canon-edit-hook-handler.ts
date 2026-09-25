// concern: canon-edit-hook-handler
/** Coordinates hook facts while keeping stdin/stdout, filesystem, and database adapters outside. */
import { resolve } from 'node:path'
import { bashWriteTargets } from './canon-edit-bash.ts'
import {
  CANON_EDIT_TOOLS,
  contextsCoveringTargets,
  decideCanonEdit,
  type EnforcedContext,
  failOpenCanonEdit,
  normalizedRepoPath,
  transcriptWriteTargets,
} from './canon-edit-guard.ts'
import {
  parseTranscriptEvents,
  type TranscriptWatermark,
  transcriptAfterWatermark,
} from './canon-edit-transcript.ts'

type Payload = {
  session_id: string
  transcript_path: string
  cwd: string
  tool_name?: string
  tool_input?: unknown
}

export type CanonEditHookPorts = {
  readContexts(root: string): EnforcedContext[]
  readTranscript(path: string): string[]
  readRegistered(cwd: string): boolean | Promise<boolean>
  readWatermark(session: string): TranscriptWatermark
  writeWatermark(session: string, line: TranscriptWatermark): void
}

export type CanonEditHookOutcome = { stdout?: string; warning?: string }

function warning(reason: string): CanonEditHookOutcome {
  return { warning: failOpenCanonEdit(reason).warning }
}

function validToolInput(tool: unknown, input: unknown): boolean {
  if (typeof tool !== 'string' || !CANON_EDIT_TOOLS.some((candidate) => candidate === tool))
    return false
  if (!input || typeof input !== 'object') return false
  const fields = input as Record<string, unknown>
  if (tool === 'Bash') return typeof fields.command === 'string'
  if (tool === 'NotebookEdit') return typeof fields.notebook_path === 'string'
  return typeof fields.file_path === 'string'
}

function payloadFrom(value: unknown, compact: boolean): Payload | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (
    typeof item.session_id !== 'string' ||
    item.session_id === '' ||
    typeof item.transcript_path !== 'string' ||
    item.transcript_path === '' ||
    typeof item.cwd !== 'string' ||
    item.cwd === '' ||
    (!compact && !validToolInput(item.tool_name, item.tool_input))
  )
    return null
  return item as Payload
}

function deny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })
}

function compactContext(paths: string[]): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `Compaction re-armed the canon guard for contexts used earlier in this session: ${paths.join(', ')}.`,
    },
  })
}

type Fact<T> = { value: T } | { outcome: CanonEditHookOutcome }

function parsedPayload(text: string, compact: boolean): Payload | null {
  try {
    return payloadFrom(JSON.parse(text), compact)
  } catch {
    return null
  }
}

function bashNeedsFacts(payload: Payload, compact: boolean, root: string): boolean {
  if (compact || payload.tool_name !== 'Bash') return true
  const command = (payload.tool_input as { command: string }).command
  return bashWriteTargets(command).some(
    (target) => normalizedRepoPath(target, payload.cwd, root) !== null,
  )
}

function contextFact(ports: CanonEditHookPorts, root: string): Fact<EnforcedContext[]> {
  try {
    const contexts = ports.readContexts(root)
    if (!Array.isArray(contexts)) throw new Error('invalid contexts')
    return { value: contexts }
  } catch {
    return { outcome: warning(`canon contexts are unreadable under ${root}`) }
  }
}

async function registerFact(ports: CanonEditHookPorts, cwd: string): Promise<Fact<boolean>> {
  try {
    return { value: await ports.readRegistered(cwd) }
  } catch {
    return { outcome: warning('project register is unreadable') }
  }
}

function transcriptFact(
  ports: CanonEditHookPorts,
  payload: Payload,
  compact: boolean,
): Fact<string[]> {
  try {
    const lines = ports.readTranscript(payload.transcript_path)
    if (!Array.isArray(lines)) throw new Error('invalid transcript')
    return { value: lines }
  } catch {
    if (!compact)
      return { outcome: warning(`transcript is unreadable at ${payload.transcript_path}`) }
    try {
      ports.writeWatermark(payload.session_id, 'unknown')
    } catch {
      return { outcome: warning('canon watermark state is unreadable') }
    }
    return {
      outcome: warning(
        `transcript is unreadable at ${payload.transcript_path}; compact watermark is unknown`,
      ),
    }
  }
}

function handleCompact(
  ports: CanonEditHookPorts,
  payload: Payload,
  root: string,
  contexts: EnforcedContext[],
  lines: string[],
): CanonEditHookOutcome {
  try {
    ports.writeWatermark(payload.session_id, lines.length)
  } catch {
    return warning('canon watermark state is unreadable')
  }
  const touched = contextsCoveringTargets({
    targets: transcriptWriteTargets(parseTranscriptEvents(lines, 0)).map(
      ({ cwdTarget }) => cwdTarget,
    ),
    cwd: payload.cwd,
    repoRoot: root,
    contexts,
  })
  return touched.length === 0 ? {} : { stdout: compactContext(touched.map(({ path }) => path)) }
}

function handleGuard(
  ports: CanonEditHookPorts,
  payload: Payload,
  root: string,
  contexts: EnforcedContext[],
  lines: string[],
): CanonEditHookOutcome {
  let watermark: TranscriptWatermark
  try {
    watermark = ports.readWatermark(payload.session_id)
  } catch {
    return warning('canon watermark state is unreadable')
  }
  const window = transcriptAfterWatermark(lines, watermark)
  if (window.anchoredAt !== null) {
    try {
      ports.writeWatermark(payload.session_id, window.anchoredAt)
    } catch {
      return warning('canon watermark state is unreadable')
    }
  }
  const decision = decideCanonEdit({
    managedContext: true,
    tool: payload.tool_name ?? '',
    toolInput: payload.tool_input,
    cwd: payload.cwd,
    repoRoot: root,
    contexts,
    events: window.events,
  })
  return decision.allow ? {} : { stdout: deny(decision.reason) }
}

/** Handle one invocation. All expected adapter failures fail open with a visible warning. */
export async function handleCanonEditHook(input: {
  payload: string
  compact: boolean
  projectRoot?: string
  ports: CanonEditHookPorts | (() => CanonEditHookPorts | Promise<CanonEditHookPorts>)
}): Promise<CanonEditHookOutcome> {
  try {
    const payload = parsedPayload(input.payload, input.compact)
    if (!payload) return warning('hook payload is malformed')
    const root = resolve(input.projectRoot ?? payload.cwd)
    if (!bashNeedsFacts(payload, input.compact, root)) return {}
    const ports = typeof input.ports === 'function' ? await input.ports() : input.ports
    const context = contextFact(ports, root)
    if ('outcome' in context) return context.outcome
    const contexts = context.value
    if (!input.compact && contexts.length === 0) return {}
    const registered = await registerFact(ports, payload.cwd)
    if ('outcome' in registered) return registered.outcome
    if (!registered.value) return {}
    const transcript = transcriptFact(ports, payload, input.compact)
    if ('outcome' in transcript) return transcript.outcome
    return input.compact
      ? handleCompact(ports, payload, root, contexts, transcript.value)
      : handleGuard(ports, payload, root, contexts, transcript.value)
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : ''
    return warning(`unexpected hook failure${detail}`)
  }
}
