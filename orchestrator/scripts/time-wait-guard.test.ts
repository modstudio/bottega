import { expect, test } from 'bun:test'
import {
  busiestDestination,
  parseNetstatTimeWait,
  parseSsTimeWait,
  timeWaitPeakExceeded,
} from './time-wait-guard.ts'

test('netstat counts TIME_WAIT rows by foreign endpoint', () => {
  const fixture = `Active Internet connections
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.51001        127.0.0.1.64321        TIME_WAIT
tcp4       0      0  127.0.0.1.51002        127.0.0.1.443          TIME_WAIT
tcp4       0      0  127.0.0.1.51003        127.0.0.1.64321        TIME_WAIT
tcp4       0      0  127.0.0.1.51004        127.0.0.1.64321        ESTABLISHED`
  const sample = parseNetstatTimeWait(fixture)
  expect(sample).toEqual({
    total: 3,
    byDestination: new Map([
      ['127.0.0.1.64321', 2],
      ['127.0.0.1.443', 1],
    ]),
  })
  if ('reason' in sample) throw new Error(sample.reason)
  expect(busiestDestination(sample)).toEqual({ destination: '127.0.0.1.64321', count: 2 })
})

test('ss counts TIME_WAIT rows by peer endpoint', () => {
  const fixture = `Recv-Q Send-Q Local Address:Port Peer Address:Port Process
0      0      127.0.0.1:51001  127.0.0.1:64321
0      0      127.0.0.1:51002  127.0.0.1:443
0      0      127.0.0.1:51003  127.0.0.1:64321`
  const sample = parseSsTimeWait(fixture)
  expect(sample).toEqual({
    total: 3,
    byDestination: new Map([
      ['127.0.0.1:64321', 2],
      ['127.0.0.1:443', 1],
    ]),
  })
  if ('reason' in sample) throw new Error(sample.reason)
  expect(busiestDestination(sample)).toEqual({ destination: '127.0.0.1:64321', count: 2 })
})

test('an ss state column excludes established rows', () => {
  const fixture = `State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
TIME-WAIT 0      0      127.0.0.1:51001  127.0.0.1:64321
ESTAB     0      0      127.0.0.1:51002  127.0.0.1:64321`
  expect(parseSsTimeWait(fixture)).toEqual({
    total: 1,
    byDestination: new Map([['127.0.0.1:64321', 1]]),
  })
})

test('empty sampler output is not a zero measurement', () => {
  expect(parseNetstatTimeWait('')).toEqual({
    reason: 'netstat output had no recognizable TCP header',
  })
  expect(parseSsTimeWait('')).toEqual({
    reason: 'ss output had no recognizable TCP header',
  })
})

test('a valid sample with no TIME_WAIT rows has no busiest destination', () => {
  const sample = parseNetstatTimeWait('Proto Recv-Q Send-Q Local Address Foreign Address (state)\n')
  if ('reason' in sample) throw new Error(sample.reason)
  expect(busiestDestination(sample)).toEqual({ count: 0 })
})

test('the threshold fails only after the configured fraction is exceeded', () => {
  expect(timeWaitPeakExceeded(100, 1_000)).toBe(false)
  expect(timeWaitPeakExceeded(101, 1_000)).toBe(true)
})
