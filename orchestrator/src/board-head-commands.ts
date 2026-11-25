// concern: board-head-command
/** Judges proposed production orchestrator edits for unheaded local board SQL. */

import { sep } from 'node:path'
import { hostedLocalBoardHeadFailures } from '../../scripts/hosted-local-board-head-check.ts'
import {
  type EditorToolPayload,
  editorTargetFile,
  parseEditorToolPayload,
  proposedEditorContent,
} from './editor-proposal.ts'

export type BoardHeadJudgment = {
  status: 'ok' | 'refused' | 'unchecked'
  findings: { rule: string; dependency: string }[]
  reason?: string
}

const BOARD_STORE_IMPORT = /\b(?:from\s*|import\s*\()\s*['"][^'"]*board-store(?:\.[cm]?[jt]s)?['"]/

/** Pure applicability decision used after the hook reconstructs the proposed whole-file content. */
export function boardHeadHookShouldAct(file: string, sourceText: string): boolean {
  const normalized = file.split(sep).join('/')
  return (
    /(?:^|\/)orchestrator\/src\/.*\.ts$/.test(normalized) &&
    !normalized.endsWith('.test.ts') &&
    (/\bboard_[a-z0-9_]+\b/i.test(sourceText) || BOARD_STORE_IMPORT.test(sourceText))
  )
}

function checkoutRelativeFile(file: string): string | null {
  const normalized = file.split(sep).join('/')
  const marker = '/orchestrator/src/'
  const index = normalized.lastIndexOf(marker)
  if (index < 0) return normalized.startsWith('orchestrator/src/') ? normalized : null
  return normalized.slice(index + 1)
}

export function boardHeadJudgeCommand(text: string): BoardHeadJudgment {
  let payload: EditorToolPayload
  try {
    payload = parseEditorToolPayload(text)
  } catch (error) {
    return {
      status: 'unchecked',
      findings: [],
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  const file = editorTargetFile(payload)
  if (!file) return { status: 'unchecked', findings: [], reason: 'tool input has no file path' }

  let content: string
  try {
    content = proposedEditorContent(file, payload)
  } catch (error) {
    return {
      status: 'unchecked',
      findings: [],
      reason: `candidate could not be reconstructed (${error instanceof Error ? error.message : String(error)})`,
    }
  }
  if (!boardHeadHookShouldAct(file, content)) return { status: 'ok', findings: [] }

  const original = checkoutRelativeFile(file)
  if (!original) {
    return {
      status: 'unchecked',
      findings: [],
      reason: 'candidate is not inside orchestrator/src',
    }
  }
  try {
    const failures = hostedLocalBoardHeadFailures({ file: original, sourceText: content })
    return failures.length
      ? {
          status: 'refused',
          findings: failures.map((dependency) => ({
            rule: 'local-board-sql-requires-head',
            dependency,
          })),
        }
      : { status: 'ok', findings: [] }
  } catch (error) {
    return {
      status: 'unchecked',
      findings: [],
      reason: `local board SQL head check could not decide (${error instanceof Error ? error.message : String(error)})`,
    }
  }
}
