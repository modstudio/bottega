import { expect, test } from 'bun:test'
import { hostedAccessBodyLogLine, hostedAccessLogLine } from './hosted-server.ts'

test('hosted access line includes the caller header token', () => {
  expect(
    hostedAccessLogLine({
      method: 'GET',
      pathname: '/v1/questions',
      status: 200,
      durationMs: 12.6,
      responseBytes: 42,
      caller: 'hook:heartbeat',
    }),
  ).toBe('GET /v1/questions 200 13ms bytes=42 caller=hook:heartbeat')
})

test('hosted access line marks a missing caller header', () => {
  expect(
    hostedAccessLogLine({
      method: 'GET',
      pathname: '/health',
      status: 200,
      durationMs: 1,
      caller: null,
    }),
  ).toBe('GET /health 200 1ms bytes=- caller=-')
})

test('hosted body completion line names measured bytes and finish state', () => {
  expect(
    hostedAccessBodyLogLine({
      method: 'GET',
      pathname: '/v1/board/stream',
      status: 200,
      responseBytes: 24,
      finish: 'cancelled',
      caller: 'cli:board/watch',
    }),
  ).toBe('GET /v1/board/stream 200 body bytes=24 finish=cancelled caller=cli:board/watch')
})
