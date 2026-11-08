import { expect, test } from 'bun:test'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import { environmentRecordSessionDecision } from './setup-environment-runtime.ts'

test('decides record-backed environment rendering from authority and render results', () => {
  expect(
    environmentRecordSessionDecision({ verdict: 'local-authoritative' }, false, {
      kind: 'not-run',
    }),
  ).toEqual({ action: 'local-authoritative' })
  expect(
    environmentRecordSessionDecision({ verdict: 'hosted' }, true, { kind: 'rendered' }),
  ).toEqual({ action: 'hosted' })
  expect(
    environmentRecordSessionDecision({ verdict: 'hosted' }, false, { kind: 'not-run' }),
  ).toEqual({ action: 'wait-for-sign-in' })
  expect(
    environmentRecordSessionDecision({ verdict: 'hosted' }, true, {
      kind: 'config-error',
      reason: 'not-configured',
      status: null,
      message: `hosted config is not configured; ${RECORD_SIGN_IN_REMEDY}`,
    }),
  ).toEqual({ action: 'wait-for-sign-in' })
  expect(
    environmentRecordSessionDecision({ verdict: 'hosted' }, true, {
      kind: 'config-error',
      reason: 'response',
      status: 401,
      message: 'hosted config route /v1/config/secrets returned HTTP 401',
    }),
  ).toEqual({ action: 'wait-for-sign-in' })
  expect(
    environmentRecordSessionDecision({ verdict: 'hosted' }, true, {
      kind: 'record-error',
      errorKind: 'refused',
      status: null,
      message: `record credentials were refused; ${RECORD_SIGN_IN_REMEDY}`,
    }),
  ).toEqual({ action: 'wait-for-sign-in' })
  expect(
    environmentRecordSessionDecision(
      {
        verdict: 'refused',
        refusal: 'record address changed',
        boundOrigin: 'https://record.example',
        resolvedOrigin: 'https://other.example',
      },
      false,
      { kind: 'not-run' },
    ),
  ).toEqual({ action: 'refuse', refusal: 'record address changed' })
  expect(
    environmentRecordSessionDecision({ verdict: 'hosted' }, true, {
      kind: 'error',
      message: 'refusing settings render: no settings row for user',
    }),
  ).toEqual({ action: 'refuse', refusal: 'refusing settings render: no settings row for user' })
})
