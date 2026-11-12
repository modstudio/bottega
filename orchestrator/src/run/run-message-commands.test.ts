// concern: run-control
import { expect, test } from 'bun:test'
import { answerInputFromArgv } from './run-message-commands.ts'

const flags = { detach: false, follow: false, quiet: false }
const helpers = {
  readWorkerFile: () => '',
  readMessageText: async () => '',
}

test('question answer applies the ruling shape before producing answer input', async () => {
  await expect(
    answerInputFromArgv(['x'.repeat(1501)], false, false, flags, helpers),
  ).rejects.toThrow('ruling is 1501 characters; the limit is 1500 (RULING_MAX_CHARS)')
  await expect(
    answerInputFromArgv(['first\n\nsecond'], false, false, flags, helpers),
  ).rejects.toThrow('ruling must be one paragraph with no blank line')
  await expect(
    answerInputFromArgv(['x'.repeat(1500)], false, false, flags, helpers),
  ).resolves.toMatchObject({ rulings: 'x'.repeat(1500) })
})
