import { expect, test } from 'bun:test'
import {
  ancestorChain,
  ancestorIdentityChain,
  commonAncestorChain,
  nextSessionAncestorChain,
  parseStoredAncestorChain,
  sessionAnchors,
} from './session-process-anchoring.ts'

const identity = (pid: number, birth = `birth-${pid}`) => ({ pid, startTime: birth })

test('sessions under one terminal receive distinct harness anchors', () => {
  const anchors = sessionAnchors([
    { sessionId: 'one', chain: [101, 50, 20, 1].map((pid) => identity(pid)) },
    { sessionId: 'two', chain: [102, 50, 20, 1].map((pid) => identity(pid)) },
  ])
  expect(anchors).toEqual(
    new Map([
      ['one', identity(101)],
      ['two', identity(102)],
    ]),
  )
  expect([...anchors.values()].map(({ pid }) => pid)).not.toContain(50)
})

test('a single session anchors at its nearest ancestor, never pid 1 or the terminal', () => {
  const anchors = sessionAnchors([
    { sessionId: 'solo', chain: [400, 300, 1].map((pid) => identity(pid)) },
  ])
  expect(anchors.get('solo')).toEqual(identity(400))
  expect(sessionAnchors([{ sessionId: 'init', chain: [identity(1)] }])).toEqual(new Map())
})

test('differing shells converge on the deepest common ancestor', () => {
  expect(
    commonAncestorChain(
      [identity(501), identity(400), identity(300), identity(1)],
      [identity(502), identity(400), identity(300), identity(1)],
    ),
  ).toEqual([identity(400), identity(300), identity(1)])
})

test('a collapsed chain recovers when a resumed session moves', () => {
  expect(
    nextSessionAncestorChain([identity(1)], [identity(701), identity(300), identity(1)]),
  ).toEqual([identity(701), identity(300), identity(1)])
  expect(
    nextSessionAncestorChain(
      [identity(400), identity(300), identity(1)],
      [identity(701), identity(300), identity(1)],
    ),
  ).toEqual([identity(701), identity(300), identity(1)])
})

test('a reused pid with another start time is not a common anchor', () => {
  expect(
    nextSessionAncestorChain(
      [identity(400, 'old'), identity(300), identity(1)],
      [identity(400, 'new'), identity(300), identity(1)],
    ),
  ).toEqual([identity(400, 'new'), identity(300), identity(1)])
})

test('an anchor shared with another live session is rejected for both', () => {
  const chain = [identity(400, 'harness'), identity(300, 'terminal'), identity(1, 'init')]
  expect(
    sessionAnchors([
      { sessionId: 'one', chain },
      { sessionId: 'two', chain },
    ]),
  ).toEqual(new Map())
})

test('ancestor chains stop at pid 1 and at a missing parent', () => {
  const processes = [
    { pid: 1, ppid: 0, cpu: 0, command: 'init', startTime: 'one' },
    { pid: 10, ppid: 1, cpu: 0, command: 'terminal', startTime: 'ten' },
    { pid: 11, ppid: 10, cpu: 0, command: 'cli', startTime: 'eleven' },
    { pid: 20, ppid: 19, cpu: 0, command: 'detached', startTime: 'twenty' },
  ]
  expect(ancestorChain(11, processes)).toEqual([10, 1])
  expect(ancestorChain(20, processes)).toEqual([19])
  expect(ancestorIdentityChain(11, processes)).toEqual([
    { pid: 10, startTime: 'ten' },
    { pid: 1, startTime: 'one' },
  ])
})

test('stored ancestor chain parsing reports malformed rows without throwing', () => {
  expect(parseStoredAncestorChain('broken-session', 'not json')).toEqual({
    chain: null,
    error: 'session broken-session has an invalid stored ancestor_chain',
  })
})
