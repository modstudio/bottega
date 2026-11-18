import { describe, expect, test } from 'bun:test'
import { decideFallbackCompletion } from './fallback-completion.ts'

const progressReplies = [
  JSON.stringify({
    status: 'done',
    summary:
      "The affected run required a collection call and is still executing under the same supervised run. I'm continuing to collect it rather than starting a duplicate test execution.",
    files_changed: null,
    tests: null,
  }),
  JSON.stringify({
    status: 'done',
    summary:
      "The exact related run has reached the end of test execution and found one real failing assertion in `owner-scope.test.ts`; Vitest has not yet exited or printed its final summary, likely due an open handle. I'm giving it another short collection window, then I'll terminate if necessary, fix that failure, and rerun...",
    files_changed: null,
    tests: null,
  }),
]

describe('fallback completion decision', () => {
  test.each(progressReplies)('a timed-out sighted progress reply is incomplete', (finalMessage) => {
    expect(
      decideFallbackCompletion({
        writesJob: true,
        timedOut: true,
        replyFilePresent: false,
        finalMessage,
      }),
    ).toBe(false)
  })

  test.each(progressReplies)(
    'a non-timeout sighted progress reply is incomplete',
    (finalMessage) => {
      expect(
        decideFallbackCompletion({
          writesJob: true,
          timedOut: false,
          replyFilePresent: false,
          finalMessage,
        }),
      ).toBe(false)
    },
  )

  test('a non-timeout result summary is complete', () => {
    expect(
      decideFallbackCompletion({
        writesJob: true,
        timedOut: false,
        replyFilePresent: false,
        finalMessage: JSON.stringify({ status: 'done', summary: 'Implemented X; tests pass.' }),
      }),
    ).toBe(true)
  })

  test('reply.json and reader replies retain their completion behavior', () => {
    const progress = progressReplies[0]!
    expect(
      decideFallbackCompletion({
        writesJob: true,
        timedOut: true,
        replyFilePresent: true,
        finalMessage: progress,
      }),
    ).toBe(true)
    expect(
      decideFallbackCompletion({
        writesJob: false,
        timedOut: true,
        replyFilePresent: false,
        finalMessage: progress,
      }),
    ).toBe(true)
  })
})
