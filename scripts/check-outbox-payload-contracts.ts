#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../orchestrator/src/record/outbox-payload-contracts.ts'
import {
  type OutboxPayloadBaseline,
  outboxPayloadContractFailures,
} from './outbox-payload-contracts.ts'

function baseline(): OutboxPayloadBaseline {
  const path = fileURLToPath(new URL('./quality/outbox-payload-contracts.json', import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as OutboxPayloadBaseline
}

if (import.meta.main) {
  const failures = outboxPayloadContractFailures(baseline(), OUTBOX_PAYLOAD_CONTRACTS)
  if (failures.length > 0) {
    console.error(
      `outbox payload contract check failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    )
    process.exit(1)
  }
}
