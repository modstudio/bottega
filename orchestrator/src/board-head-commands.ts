// concern: board-head-command
/** Judges proposed production orchestrator edits for unheaded local board SQL. */

import type { Database } from 'bun:sqlite'
import { relative, sep } from 'node:path'
import { hostedLocalBoardHeadFailures } from '../../scripts/hosted-local-board-head-check.ts'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import { openReadOnlyDatabase } from './database/db.ts'
import type { EditorJudgment } from './editor-judgment.ts'
import {
  type EditorToolPayload,
  editorTargetFile,
  parseEditorToolPayload,
  proposedEditorContent,
} from './editor-proposal.ts'
import { registeredCheckoutForFile } from './registered-checkout.ts'

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

export function boardHeadJudgeCommand(
  text: string,
  openDatabase: () => Database = openReadOnlyDatabase,
): EditorJudgment {
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

  let database: Database
  try {
    database = openDatabase()
  } catch (error) {
    return {
      status: 'unchecked',
      findings: [],
      reason: `project register could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  let target: ReturnType<typeof registeredCheckoutForFile>
  try {
    target = registeredCheckoutForFile(file, database)
  } finally {
    database.close()
  }
  if (!target)
    return {
      status: 'unchecked',
      findings: [],
      reason: `candidate ${file} is not inside a registered ${PLATFORM_NAME} checkout`,
    }
  const original = relative(target.checkout, target.file).split(sep).join('/')
  if (!original.startsWith('orchestrator/src/'))
    return {
      status: 'unchecked',
      findings: [],
      reason: `candidate ${file} is outside orchestrator/src`,
    }
  try {
    const failures = hostedLocalBoardHeadFailures({ file: original, sourceText: content })
    return failures.length
      ? {
          status: 'refused',
          findings: failures.map((dependency) => ({
            rule: 'local-board-sql-requires-head',
            dependency: `${file} (${dependency})`,
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
