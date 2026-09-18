import { describe, expect, test } from 'bun:test'
import { deferredWorkerMessageNotice } from './mailbox-notice.ts'

describe('worker message delivery wording', () => {
  test('warns and gives the continuation remedy when the transport cannot inject', () => {
    expect(deferredWorkerMessageNotice(4935, false)).toBe(
      'It will NOT reach the running turn unless the worker polls check_orchestrator_messages. ' +
        'It WILL be included in the next turn\'s prompt; after this turn ends, run "orch continue 4935" to deliver it now-ish.',
    )
  })

  test('leaves output unchanged when the transport can inject', () => {
    expect(deferredWorkerMessageNotice(4935, true)).toBe('')
  })
})
