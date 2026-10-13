import { expect, test } from 'bun:test'
import { BOARD_STREAM_EVENT } from '../record/record-board-stream.ts'
import { createBoardStreamParser } from './board-watch-frames.ts'

const eventFrame = (revision: string) =>
  `id: ${revision}\nevent: ${BOARD_STREAM_EVENT.name}\ndata: ${JSON.stringify({ revision })}\n\n`

test('a complete event frame yields its revision', () => {
  expect(createBoardStreamParser().push(eventFrame('12'))).toEqual([
    { kind: 'event', revision: '12' },
  ])
})

test('a heartbeat comment is not an event', () => {
  expect(createBoardStreamParser().push(': heartbeat\n\n')).toEqual([{ kind: 'heartbeat' }])
})

test('a frame split across two chunks is held until it is complete', () => {
  const parser = createBoardStreamParser()
  const frame = eventFrame('4')
  const cut = frame.indexOf('\n') + 1
  expect(parser.push(frame.slice(0, cut))).toEqual([])
  expect(parser.push(frame.slice(cut))).toEqual([{ kind: 'event', revision: '4' }])
})

test('two frames in one chunk both parse', () => {
  expect(createBoardStreamParser().push(`${eventFrame('1')}: heartbeat\n\n`)).toEqual([
    { kind: 'event', revision: '1' },
    { kind: 'heartbeat' },
  ])
})

test('a malformed frame is counted and is not an event', () => {
  const parser = createBoardStreamParser()
  expect(parser.push('event: other\ndata: {}\n\n')).toEqual([{ kind: 'malformed' }])
  expect(parser.push(`event: ${BOARD_STREAM_EVENT.name}\ndata: not-json\n\n`)).toEqual([
    { kind: 'malformed' },
  ])
  expect(parser.push(`event: ${BOARD_STREAM_EVENT.name}\ndata: {"revision":"x"}\n\n`)).toEqual([
    { kind: 'malformed' },
  ])
})
