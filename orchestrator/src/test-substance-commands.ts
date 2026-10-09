// concern: test-substance-command
/** Validates proposed test edits and delegates their substance judgment to shared policy. */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isTestFile,
  judgeTestSubstance,
  PHP_POLICY_RULES,
  type TestSubstanceInput,
  type TestSubstanceJudgment,
} from '../../shared/test-substance/test-substance.ts'

export const MAX_TEST_FILE_BYTES = 1024 * 1024

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
        ? content.split(oldString).join(newString)
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
    ? { status: 'ready', input: { file, before, after: toolInput.content, phpPolicyRules: [] } }
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
    : { status: 'ready', input: { file, before, after: result.content, phpPolicyRules: [] } }
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
  return { status: 'ready', input: { file, before, after, phpPolicyRules: [] } }
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
  const phpPolicyRules = input?.phpPolicyRules ?? []
  if (
    !input ||
    typeof input.file !== 'string' ||
    (input.before !== null && typeof input.before !== 'string') ||
    typeof input.after !== 'string' ||
    !Array.isArray(phpPolicyRules) ||
    !phpPolicyRules.every(
      (rule) => typeof rule === 'string' && PHP_POLICY_RULES.includes(rule as never),
    )
  ) {
    throw new Error(
      'input must be {"file":string,"before":string|null,"after":string,"phpPolicyRules"?:string[]}',
    )
  }
  return {
    file: input.file,
    before: input.before,
    after: input.after,
    phpPolicyRules: phpPolicyRules as TestSubstanceInput['phpPolicyRules'],
  }
}

type TargetRead =
  | { status: 'ready'; before: string | null }
  | { status: 'unchecked'; reason: string }

function readBefore(file: string): TargetRead {
  try {
    const metadata = statSync(file)
    if (!metadata.isFile()) return { status: 'unchecked', reason: 'target is not a regular file' }
    if (metadata.size > MAX_TEST_FILE_BYTES) {
      return {
        status: 'unchecked',
        reason: `target is larger than ${MAX_TEST_FILE_BYTES} bytes`,
      }
    }
    return { status: 'ready', before: readFileSync(file, 'utf8') }
  } catch (error) {
    if (object(error)?.code === 'ENOENT') return { status: 'ready', before: null }
    return {
      status: 'unchecked',
      reason: `target could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function proposedContentLimit(input: TestSubstanceInput): TestSubstanceJudgment | undefined {
  return Buffer.byteLength(input.after) > MAX_TEST_FILE_BYTES
    ? {
        status: 'unchecked',
        findings: [],
        reason: `proposed content is larger than ${MAX_TEST_FILE_BYTES} bytes`,
      }
    : undefined
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
  if (!rawToolInput) {
    const input = parsePublicInput(value)
    if (!isTestFile(input.file)) return { status: 'ok', findings: [], reason: '' }
    const tooLarge = proposedContentLimit(input)
    return tooLarge ?? judge(input)
  }
  const payload = value as ToolPayload
  const toolInput = object(payload.tool_input)
  const { file, rawPath } = resolveToolFile(payload, toolInput)
  if (typeof rawPath === 'string' && !isTestFile(file)) {
    return { status: 'ok', findings: [], reason: '' }
  }
  const target = readBefore(file)
  if (target.status === 'unchecked') {
    return { status: 'unchecked', findings: [], reason: target.reason }
  }
  const reconstruction = reconstructTestEdit(payload, () => target.before)
  if (reconstruction.status === 'unchecked') {
    return { status: 'unchecked', findings: [], reason: reconstruction.reason }
  }
  const tooLarge = proposedContentLimit(reconstruction.input)
  return tooLarge ?? judge(reconstruction.input)
}
