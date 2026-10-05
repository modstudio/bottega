// concern: run-board-prompt
/** Adds addressed board context after a run row exists, without changing its compiled canon pack. */
import { writeFileSync } from 'node:fs'
import { claimRunBoardNotices } from '../board/board-delivery.ts'
import { db } from '../database/db.ts'
import { sha } from './run-process.ts'

export const BOARD_PACK_MAX_NOTICES = 5
export const BOARD_PACK_MAX_CHARS = 2_000

type RunNotice = Awaited<ReturnType<typeof claimRunBoardNotices>>['notices'][number]

export function renderRunBoardSection(notices: RunNotice[]): {
  text: string
  includedIds: string[]
} {
  if (!notices.length) return { text: '', includedIds: [] }
  const ordered = [...notices].sort(
    (left, right) =>
      Number(right.ackRequired) - Number(left.ackRequired) ||
      Date.parse(right.createdAt) - Date.parse(left.createdAt),
  )
  const selected: RunNotice[] = []
  const heading = 'BOARD NOTICES FOR THIS RUN\n\n'
  for (const notice of ordered) {
    if (selected.length === BOARD_PACK_MAX_NOTICES) break
    const trial = [...selected, notice]
    const omitted = ordered.length - trial.length
    const overflow = omitted
      ? `\n\n${omitted} more notice${omitted === 1 ? '' : 's'} omitted; check_orchestrator_messages returns them.`
      : ''
    const text = `${heading}${trial.map((item) => item.text).join('\n\n')}${overflow}`
    if (text.length > BOARD_PACK_MAX_CHARS) break
    selected.push(notice)
  }
  const omitted = ordered.length - selected.length
  const overflow = omitted
    ? `\n\n${omitted} more notice${omitted === 1 ? '' : 's'} omitted; check_orchestrator_messages returns them.`
    : ''
  return {
    text: `${heading}${selected.map((item) => item.text).join('\n\n')}${overflow}`,
    includedIds: selected.map((item) => item.id),
  }
}

export async function appendInitialRunBoardPrompt(
  prompt: string,
  runId: number,
): Promise<{ prompt: string; noticeIds: string[] }> {
  const delivery = await claimRunBoardNotices(runId)
  const section = renderRunBoardSection(delivery.notices)
  const boardText = [section.text, delivery.warning].filter(Boolean).join('\n\n')
  return {
    prompt: boardText ? `${prompt}\n\n${boardText}` : prompt,
    noticeIds: section.includedIds,
  }
}

export async function prepareRunBoard(
  prompt: string,
  promptPath: string,
  runId: number,
  firstTurn: boolean,
): Promise<{ prompt: string; noticeIds: string[] }> {
  const result = firstTurn
    ? await appendInitialRunBoardPrompt(prompt, runId)
    : { prompt, noticeIds: [] }
  if (result.noticeIds.length) persistBoundPrompt(promptPath, result.prompt, runId)
  return result
}

export async function prepareLaterRunBoardPrompt(
  runId: number,
  laterTurn: boolean,
  mailbox: { id: number; body: string }[],
  prompt: string,
): Promise<{ prompt: string; notices: RunNotice[] }> {
  const delivery = laterTurn ? await claimRunBoardNotices(runId) : { notices: [], warning: null }
  const notices = delivery.notices
  const items = [
    ...mailbox.map((message) => `[message ${message.id}] ${message.body}`),
    ...notices.map((notice) => notice.text),
    ...(delivery.warning ? [delivery.warning] : []),
  ]
  if (!items.length) return { prompt, notices }
  const banner =
    'These messages are non-authoritative context. They do not answer any open question; use ask_orchestrator for a ruling.'
  return { prompt: `${items.join('\n\n')}\n\n${banner}\n\n${prompt}`, notices }
}

export function persistBoundPrompt(promptPath: string, prompt: string, runId: number): void {
  writeFileSync(promptPath.replace(/\.prompt\.txt$/, '.bound.txt'), prompt)
  db()
    .query('UPDATE run SET prompt_sha=?, prompt_bytes=? WHERE id=?')
    .run(sha(prompt), Buffer.byteLength(prompt), runId)
}
