import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type EditorToolPayload = {
  tool_name?: unknown
  tool_input?: unknown
  cwd?: unknown
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function replacement(source: string, edit: Record<string, unknown>) {
  const oldString = edit.old_string
  const newString = edit.new_string
  if (
    typeof oldString !== 'string' ||
    typeof newString !== 'string' ||
    !source.includes(oldString)
  ) {
    throw new Error('edit strings do not describe the current file')
  }
  return edit.replace_all === true
    ? source.split(oldString).join(newString)
    : source.replace(oldString, newString)
}

/** Reconstruct the whole file exactly as editor PreToolUse judges will see it. */
export function proposedEditorContent(file: string, payload: EditorToolPayload) {
  const input = object(payload.tool_input)
  if (!input) throw new Error('tool input is not an object')
  if (payload.tool_name === 'Write') {
    if (typeof input.content !== 'string') throw new Error('Write has no content')
    return input.content
  }
  let content = readFileSync(file, 'utf8')
  if (payload.tool_name === 'Edit') return replacement(content, input)
  if (payload.tool_name !== 'MultiEdit' || !Array.isArray(input.edits)) {
    throw new Error('tool input is not a supported editor shape')
  }
  for (const edit of input.edits) {
    const value = object(edit)
    if (!value) throw new Error('MultiEdit contains an invalid edit')
    content = replacement(content, value)
  }
  return content
}

export function editorTargetFile(payload: EditorToolPayload) {
  const input = object(payload.tool_input)
  const raw = input?.file_path ?? input?.path
  if (typeof raw !== 'string' || raw.length === 0) return null
  return resolve(typeof payload.cwd === 'string' ? payload.cwd : process.cwd(), raw)
}

export function parseEditorToolPayload(text: string): EditorToolPayload {
  try {
    return JSON.parse(text) as EditorToolPayload
  } catch {
    throw new Error('input must be valid JSON')
  }
}
