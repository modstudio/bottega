import { expect, test } from 'bun:test'
import { BOARD_MESSAGE_NOTIFY_CHANNEL } from '../../../shared/record/board-stream.ts'
import { createBoardWakeSource } from './record-board-wake.ts'

test('a listener reconnect and the safety timer each count as a wake', async () => {
  let onlisten: () => void = () => undefined
  let safetyWake: () => void = () => undefined
  let unlistened = false
  let closed = false
  const source = await createBoardWakeSource('postgres://record.test/record', {
    listener: {
      async listen(channel, _onnotify, ready) {
        expect(channel).toBe(BOARD_MESSAGE_NOTIFY_CHANNEL)
        onlisten = ready
        return {
          async unlisten() {
            unlistened = true
          },
        }
      },
      async close() {
        closed = true
      },
    },
    clock: {
      setInterval(callback) {
        safetyWake = callback
        return 1 as unknown as ReturnType<typeof setInterval>
      },
      clearInterval() {},
    },
  })
  let wakes = 0
  source.subscribe(() => wakes++)
  onlisten()
  safetyWake()
  expect(wakes).toBe(2)
  await source.close()
  expect(unlistened).toBe(true)
  expect(closed).toBe(true)
})
