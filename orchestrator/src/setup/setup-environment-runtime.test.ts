import { expect, test } from 'bun:test'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import {
  environmentRecordSessionDecision,
  environmentRecordStepsDecision,
  environmentSettingsApplyDecision,
} from './setup-environment-runtime.ts'

test('gates record-session-required environment steps while waiting for sign-in', () => {
  expect(environmentRecordStepsDecision({ action: 'wait-for-sign-in' })).toEqual({
    runSessionRequiredSteps: false,
  })
  expect(environmentRecordStepsDecision({ action: 'hosted' })).toEqual({
    runSessionRequiredSteps: true,
  })
})

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
    environmentRecordSessionDecision({ verdict: 'hosted' }, true, {
      kind: 'error',
      message: RECORD_SIGN_IN_REMEDY,
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

test('decides environment settings refusals from session presence and structured conditions', () => {
  const missingRow = {
    target: 'settings /home/user/.claude/settings.json',
    outcome: 'refused' as const,
    condition: 'no-settings-row' as const,
    detail: 'refusing settings render: no settings row for user',
    changed: false,
  }
  expect(environmentSettingsApplyDecision(false, [missingRow])).toEqual({
    action: 'wait-for-sign-in',
  })
  expect(environmentSettingsApplyDecision(true, [missingRow])).toEqual({
    action: 'refuse',
    refusal: 'refusing settings render: no settings row for user',
  })
  expect(
    environmentSettingsApplyDecision(false, [
      missingRow,
      {
        target: 'canon claude',
        outcome: 'refused',
        detail: 'refusing canon write',
        changed: false,
      },
    ]),
  ).toEqual({ action: 'refuse', refusal: 'refusing canon write' })
})
