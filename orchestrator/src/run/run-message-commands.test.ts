// concern: run-control
import { expect, test } from 'bun:test'
import { answerInputFromArgv } from './run-message-commands.ts'

const flags = { detach: false, follow: false, quiet: false }
const helpers = {
  readWorkerFile: () => '',
  readMessageText: async () => '',
}

test('question answer keeps CLI worker-text validation before producing answer input', async () => {
  await expect(
    answerInputFromArgv(['first\0second'], false, false, flags, helpers),
  ).rejects.toThrow('ruling contains a NUL at byte offset 5')
})
