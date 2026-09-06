import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qwenSession } from './agents.ts'

test('qwen session recovery reads a recording from the effective sandbox HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-qwen-home-'))
  const cwd = '/runs/qwen-tree'
  const prompt = 'recover this exact sandbox recording'
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-')
  const chats = join(home, '.qwen', 'projects', slug, 'chats')
  mkdirSync(chats, { recursive: true })
  writeFileSync(
    join(chats, 'sandbox-session.jsonl'),
    `${JSON.stringify({ message: { parts: [{ text: prompt }] } })}\n`,
  )

  expect(qwenSession({ cwd, prompt, startedAt: Date.now() - 100, home }))
    .toBe('sandbox-session')
  rmSync(home, { recursive: true, force: true })
})
