// concern: hub-import-command
/** Resolves registered Bottega checkouts and judges proposed hub edits with installed policy. */

import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, sep } from 'node:path'
import { isDeadlineAbort, startBounded } from '../../shared/bounded-process.ts'
import { optionalCheckoutRoot } from '../../shared/install-root.ts'
import { openReadOnlyDatabase } from './database/db.ts'
import type { EditorJudgment } from './editor-judgment.ts'
import {
  editorTargetFile,
  parseEditorToolPayload,
  proposedEditorContent,
} from './editor-proposal.ts'
import {
  registeredBottegaCheckout,
  registeredCheckoutForFile,
  type RegisteredCheckoutTarget,
} from './registered-checkout.ts'

// Must leave enough of the hook's absolute deadline for candidate and directory cleanup.
const JUDGE_CLEANUP_MARGIN_MS = 500

function hubImportPolicyRoot(): string | null {
  return optionalCheckoutRoot(import.meta.dir, process.env)
}

/** Pure applicability decision after the project register has resolved the owning project. */
export function registeredHubCheckout(
  file: string,
  project: Parameters<typeof registeredBottegaCheckout>[1],
): RegisteredCheckoutTarget | null {
  const target = registeredBottegaCheckout(file, project)
  if (!target) return null
  const checkoutRelative = relative(target.checkout, target.file).split(sep).join('/')
  return checkoutRelative.startsWith('hub/') ? target : null
}

async function runInstalledJudge(
  judge: string,
  args: string[],
  installedRoot: string,
  deadlineMs: number,
): Promise<EditorJudgment> {
  const timeoutMs = deadlineMs - Date.now() - JUDGE_CLEANUP_MARGIN_MS
  if (timeoutMs <= 0) {
    return {
      status: 'unchecked',
      findings: [],
      reason: 'judge deadline leaves no time before the cleanup margin',
    }
  }
  try {
    const child = await startBounded([process.execPath, '--no-env-file', judge, ...args], {
      budget: 'self-cli',
      cwd: installedRoot,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (child.exitCode !== 0) {
      return {
        status: 'unchecked',
        findings: [],
        reason: `judge failed (${child.stderr.trim().replaceAll('\n', ' ') || `exit ${child.exitCode}`})`,
      }
    }
    return JSON.parse(child.stdout) as EditorJudgment
  } catch (error) {
    if (!isDeadlineAbort(error)) throw error
    return {
      status: 'unchecked',
      findings: [],
      reason: 'judge child reached the hook deadline cleanup margin',
    }
  }
}

function createCandidateDirectories(directory: string, created: string[]) {
  const missing: string[] = []
  let current = directory
  while (!existsSync(current)) {
    missing.push(current)
    const parent = dirname(current)
    if (parent === current) throw new Error(`no existing ancestor for ${directory}`)
    current = parent
  }
  for (const path of missing.reverse()) {
    mkdirSync(path)
    created.push(path)
  }
}

async function judgeOriginalPath(
  file: string,
  checkout: string,
  judge: string,
  installedRoot: string,
  deadlineMs: number,
): Promise<EditorJudgment | null> {
  const original = relative(checkout, file).split(sep).join('/')
  try {
    const judgment = await runInstalledJudge(
      judge,
      [original, original, checkout, '--deadline-ms', String(deadlineMs), '--path-only'],
      installedRoot,
      deadlineMs,
    )
    return judgment.status === 'ok' ? null : judgment
  } catch (error) {
    return {
      status: 'unchecked',
      findings: [],
      reason: `judge could not run (${error instanceof Error ? error.message : String(error)})`,
    }
  }
}

export async function hubImportJudgeCommand(
  text: string,
  deadlineMs: number,
  openDatabase: () => Database = openReadOnlyDatabase,
): Promise<EditorJudgment> {
  const payload = parseEditorToolPayload(text)
  const file = editorTargetFile(payload)
  if (!file) return { status: 'unchecked', findings: [], reason: 'tool input has no file path' }

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
  let target: RegisteredCheckoutTarget | null
  try {
    const registered = registeredCheckoutForFile(file, database)
    target =
      registered &&
      relative(registered.checkout, registered.file).split(sep).join('/').startsWith('hub/')
        ? registered
        : null
  } finally {
    database.close()
  }
  if (!target) return { status: 'ok', findings: [] }

  const installedRoot = hubImportPolicyRoot()
  if (!installedRoot) {
    return {
      status: 'unchecked',
      findings: [],
      reason: 'hub import judging requires the policy scripts from a development checkout',
    }
  }

  const { checkout, file: canonicalFile } = target

  const judge = join(installedRoot, 'scripts/check-architecture-file.ts')
  const original = relative(checkout, canonicalFile).split(sep).join('/')
  const pathJudgment = await judgeOriginalPath(
    canonicalFile,
    checkout,
    judge,
    installedRoot,
    deadlineMs,
  )
  if (pathJudgment) return pathJudgment

  let content: string
  try {
    content = proposedEditorContent(canonicalFile, payload)
  } catch (error) {
    return {
      status: 'unchecked',
      findings: [],
      reason: `candidate could not be reconstructed (${error instanceof Error ? error.message : String(error)})`,
    }
  }

  const candidate = join(
    dirname(canonicalFile),
    `.architecture-guard-${randomUUID()}${extname(canonicalFile)}`,
  )
  const createdDirectories: string[] = []
  try {
    if (deadlineMs - Date.now() <= JUDGE_CLEANUP_MARGIN_MS) {
      return {
        status: 'unchecked',
        findings: [],
        reason: 'judge deadline leaves no time to write and clean up a candidate',
      }
    }
    createCandidateDirectories(dirname(candidate), createdDirectories)
    writeFileSync(candidate, content)
    return await runInstalledJudge(
      judge,
      [
        relative(checkout, candidate).split(sep).join('/'),
        original,
        checkout,
        '--deadline-ms',
        String(deadlineMs),
      ],
      installedRoot,
      deadlineMs,
    )
  } catch (error) {
    return {
      status: 'unchecked',
      findings: [],
      reason: `judge could not run (${error instanceof Error ? error.message : String(error)})`,
    }
  } finally {
    rmSync(candidate, { force: true })
    for (const directory of createdDirectories.reverse()) rmdirSync(directory)
  }
}
