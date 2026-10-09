// concern: test-substance-command
/** Validates proposed test edits and delegates their substance judgment to shared policy. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  judgeTestSubstance,
  type TestSubstanceInput,
  type TestSubstanceJudgment,
} from '../../../shared/test-substance/test-substance.ts'

type ToolPayload = {
  tool_name?: unknown
  tool_input?: unknown
  cwd?: unknown
}

export type Reconstruction =
  | { status: 'ready'; input: TestSubstanceInput }
  | { status: 'unchecked'; file: string; reason: string }

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function replaced(
  content: string,
  oldString: unknown,
  newString: unknown,
  replaceAll: unknown,
): { content?: string; reason?: string } {
  if (typeof oldString !== 'string' || typeof newString !== 'string') {
    return { reason: 'edit old_string and new_string must be strings' }
  }
  if (!content.includes(oldString)) return { reason: 'old_string does not occur in the file' }
  return {
    content:
      replaceAll === true
        ? content.replaceAll(oldString, newString)
        : `${content.slice(0, content.indexOf(oldString))}${newString}${content.slice(content.indexOf(oldString) + oldString.length)}`,
  }
}

function resolveToolFile(payload: ToolPayload, toolInput: Record<string, unknown> | undefined) {
  const rawPath = toolInput?.file_path ?? toolInput?.path
  const file =
    typeof rawPath === 'string'
      ? resolve(typeof payload.cwd === 'string' ? payload.cwd : process.cwd(), rawPath)
      : '<unknown test file>'
  return { file, rawPath }
}

function reconstructWrite(
  file: string,
  before: string | null,
  toolInput: Record<string, unknown>,
): Reconstruction {
  return typeof toolInput.content === 'string'
    ? { status: 'ready', input: { file, before, after: toolInput.content } }
    : { status: 'unchecked', file, reason: 'Write input has no string content' }
}

function reconstructEdit(
  file: string,
  before: string,
  toolInput: Record<string, unknown>,
): Reconstruction {
  const result = replaced(before, toolInput.old_string, toolInput.new_string, toolInput.replace_all)
  return result.content === undefined
    ? { status: 'unchecked', file, reason: result.reason! }
    : { status: 'ready', input: { file, before, after: result.content } }
}

function reconstructMultiEdit(file: string, before: string, edits: unknown[]): Reconstruction {
  let after = before
  for (const edit of edits) {
    const value = object(edit)
    if (!value) return { status: 'unchecked', file, reason: 'MultiEdit contains an invalid edit' }
    const result = replaced(after, value.old_string, value.new_string, value.replace_all)
    if (result.content === undefined) {
      return { status: 'unchecked', file, reason: result.reason! }
    }
    after = result.content
  }
  return { status: 'ready', input: { file, before, after } }
}

/** Reconstruct the whole file produced by one editor-tool call, without applying it. */
export function reconstructTestEdit(
  payload: ToolPayload,
  read: (file: string) => string | null,
): Reconstruction {
  const toolInput = object(payload.tool_input)
  const { file, rawPath } = resolveToolFile(payload, toolInput)
  if (!toolInput || typeof rawPath !== 'string') {
    return { status: 'unchecked', file, reason: 'tool input has no file path' }
  }
  const before = read(file)
  if (payload.tool_name === 'Write') {
    return reconstructWrite(file, before, toolInput)
  }
  if (before === null) {
    return { status: 'unchecked', file, reason: 'the file to edit does not exist' }
  }
  if (payload.tool_name === 'Edit') {
    return reconstructEdit(file, before, toolInput)
  }
  if (payload.tool_name === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return reconstructMultiEdit(file, before, toolInput.edits)
  }
  return { status: 'unchecked', file, reason: 'tool input is not a supported editor shape' }
}

function parsePublicInput(value: unknown): TestSubstanceInput {
  const input = object(value)
  if (
    !input ||
    typeof input.file !== 'string' ||
    (input.before !== null && typeof input.before !== 'string') ||
    typeof input.after !== 'string'
  ) {
    throw new Error('input must be {"file":string,"before":string|null,"after":string}')
  }
  return { file: input.file, before: input.before, after: input.after }
}

function readBefore(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (object(error)?.code === 'ENOENT') return null
    throw error
  }
}

export async function testSubstanceJudgeCommand(
  text: string,
  rawToolInput: boolean,
  judge: (input: TestSubstanceInput) => Promise<TestSubstanceJudgment> = judgeTestSubstance,
): Promise<TestSubstanceJudgment> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('input must be valid JSON')
  }
  if (!rawToolInput) return judge(parsePublicInput(value))
  const reconstruction = reconstructTestEdit(value as ToolPayload, readBefore)
  if (reconstruction.status === 'unchecked') {
    return { status: 'unchecked', findings: [], reason: reconstruction.reason }
  }
  return judge(reconstruction.input)
}
