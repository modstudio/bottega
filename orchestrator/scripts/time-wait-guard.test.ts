import { expect, test } from 'bun:test'
import {
  parseNetstatTimeWait,
  parseSsTimeWait,
  TIME_WAIT_PEAK_FRACTION,
  timeWaitPeakExceeded,
} from './time-wait-guard.ts'

test('netstat counts TIME_WAIT rows whose foreign endpoint has the published port', () => {
  const fixture = `Active Internet connections
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.51001        127.0.0.1.64321        TIME_WAIT
tcp4       0      0  127.0.0.1.51002        127.0.0.1.443          TIME_WAIT
tcp4       0      0  127.0.0.1.51003        127.0.0.1.64321        ESTABLISHED`
  expect(parseNetstatTimeWait(fixture, 64321)).toEqual({ count: 1 })
})

test('ss counts rows whose peer endpoint has the published port', () => {
  const fixture = `Recv-Q Send-Q Local Address:Port Peer Address:Port Process
0      0      127.0.0.1:51001  127.0.0.1:64321
0      0      127.0.0.1:51002  127.0.0.1:443`
  expect(parseSsTimeWait(fixture, 64321)).toEqual({ count: 1 })
})

test('empty sampler output is not a zero measurement', () => {
  expect(parseNetstatTimeWait('', 64321)).toEqual({
    reason: 'netstat output had no recognisable TCP header',
  })
  expect(parseSsTimeWait('', 64321)).toEqual({
    reason: 'ss output had no recognisable TCP header',
  })
})

test('the threshold fails only after the configured fraction is exceeded', () => {
  expect(TIME_WAIT_PEAK_FRACTION).toBe(0.1)
  expect(timeWaitPeakExceeded(100, 1_000)).toBe(false)
  expect(timeWaitPeakExceeded(101, 1_000)).toBe(true)
})
