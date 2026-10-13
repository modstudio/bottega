import { expect, test } from 'bun:test'
import { BOARD_STREAM_EVENT } from '../record/record-board-stream.ts'
import { BOARD_WATCH_FRAME_BUFFER_MAX, createBoardStreamParser } from './board-watch-frames.ts'

const eventFrame = (revision: string, ending = '\n') =>
  `id: ${revision}${ending}event: ${BOARD_STREAM_EVENT.name}${ending}data: ${JSON.stringify({ revision })}${ending}${ending}`

test('a complete event frame yields its revision', () => {
  expect(createBoardStreamParser().push(eventFrame('12'))).toEqual({
    frames: [{ kind: 'event', revision: '12' }],
    protocolError: false,
  })
})

test('a heartbeat comment is not an event', () => {
  expect(createBoardStreamParser().push(': heartbeat\n\n')).toEqual({
    frames: [{ kind: 'heartbeat' }],
    protocolError: false,
  })
})

test('a frame split across two chunks is held until it is complete', () => {
  const parser = createBoardStreamParser()
  const frame = eventFrame('4')
  const cut = frame.indexOf('\n') + 1
  expect(parser.push(frame.slice(0, cut))).toEqual({ frames: [], protocolError: false })
  expect(parser.push(frame.slice(cut))).toEqual({
    frames: [{ kind: 'event', revision: '4' }],
    protocolError: false,
  })
})

test('two frames in one chunk both parse', () => {
  expect(createBoardStreamParser().push(`${eventFrame('1')}: heartbeat\n\n`)).toEqual({
    frames: [
      { kind: 'event', revision: '1' },
      { kind: 'heartbeat' },
    ],
    protocolError: false,
  })
})

test('a malformed frame is counted and is not an event', () => {
  const parser = createBoardStreamParser()
  expect(parser.push('event: other\ndata: {}\n\n')).toEqual({
    frames: [{ kind: 'malformed' }],
    protocolError: false,
  })
  expect(parser.push(`event: ${BOARD_STREAM_EVENT.name}\ndata: not-json\n\n`)).toEqual({
    frames: [{ kind: 'malformed' }],
    protocolError: false,
  })
  expect(parser.push(`event: ${BOARD_STREAM_EVENT.name}\ndata: {"revision":"x"}\n\n`)).toEqual({
    frames: [{ kind: 'malformed' }],
    protocolError: false,
  })
})

test('CRLF frames end at an empty line', () => {
  expect(createBoardStreamParser().push(eventFrame('7', '\r\n'))).toEqual({
    frames: [{ kind: 'event', revision: '7' }],
    protocolError: false,
  })
})

test('CR frames end at an empty line', () => {
  expect(createBoardStreamParser().push(eventFrame('8', '\r'))).toEqual({
    frames: [{ kind: 'event', revision: '8' }],
    protocolError: false,
  })
})

test('a CRLF terminator split across chunks completes the frame', () => {
  const parser = createBoardStreamParser()
  const frame = eventFrame('3', '\r\n')
  const cut = frame.lastIndexOf('\r\n\r\n') + 1
  expect(parser.push(frame.slice(0, cut))).toEqual({ frames: [], protocolError: false })
  expect(parser.push(frame.slice(cut))).toEqual({
    frames: [{ kind: 'event', revision: '3' }],
    protocolError: false,
  })
})

test('an oversized pending buffer is a protocol error', () => {
  const parser = createBoardStreamParser()
  expect(parser.push('x'.repeat(BOARD_WATCH_FRAME_BUFFER_MAX + 1))).toEqual({
    frames: [],
    protocolError: true,
  })
})
