import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCommitMessageProse, commitMessageText } from './check-prose.ts'

test('commit message extraction removes comments and the scissors tail', () => {
  expect(
    commitMessageText(
      'DEV-2016 clean subject\n# template\nBody\n# ------------------------ >8 ------------------------\nignored',
    ),
  ).toBe('DEV-2016 clean subject\nBody')
})

test('commit message prose check reports clean, refused, and missing inputs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'commit-message-prose-'))
  const message = join(directory, 'COMMIT_EDITMSG')
  try {
    writeFileSync(message, 'DEV-2016 Correct the prose gate.\n')
    expect(await checkCommitMessageProse(message)).toBe(0)
    const misspelling = ['me', 'ida'].join('')
    writeFileSync(message, `DEV-2016 We saw the ${misspelling} here.\n`)
    expect(await checkCommitMessageProse(message)).toBe(3)
    expect(await checkCommitMessageProse(undefined)).toBe(1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
