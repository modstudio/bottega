#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type OutboxPayloadContract = {
  columns: readonly string[]
  laterAdded: Readonly<Record<string, unknown>>
}

type OutboxPayloadContracts = Readonly<Record<string, OutboxPayloadContract>>
type OutboxPayloadBaseline = Readonly<Record<string, readonly string[]>>

function knownContractFailures(
  kind: string,
  baseColumns: readonly string[],
  contract: OutboxPayloadContract,
): string[] {
  const failures: string[] = []
  const currentColumns = new Set(contract.columns)
  const baseColumnSet = new Set(baseColumns)
  const laterAddedColumns = new Set(Object.keys(contract.laterAdded))
  for (const column of contract.columns) {
    if (!baseColumnSet.has(column) && !laterAddedColumns.has(column)) {
      failures.push(
        `${kind}.${column}: current column is neither a base column nor laterAdded; add a laterAdded fill`,
      )
    }
  }
  for (const column of baseColumns) {
    if (!currentColumns.has(column)) {
      failures.push(
        `${kind}.${column}: base column is no longer current; perform a deliberate migration, never a baseline edit`,
      )
    }
  }
  for (const column of laterAddedColumns) {
    if (!currentColumns.has(column)) {
      failures.push(`${kind}.${column}: laterAdded key is not a current column`)
    }
  }
  return failures
}

export function outboxPayloadContractFailures(
  baseline: OutboxPayloadBaseline,
  contracts: OutboxPayloadContracts,
): string[] {
  const failures: string[] = []
  for (const [kind, contract] of Object.entries(contracts)) {
    const baseColumns = baseline[kind]
    if (!baseColumns) {
      failures.push(`${kind}: new outbox kind; add its base column set to the baseline`)
      continue
    }
    failures.push(...knownContractFailures(kind, baseColumns, contract))
  }
  for (const kind of Object.keys(baseline)) {
    if (!(kind in contracts)) failures.push(`${kind}: stale baseline kind is no longer registered`)
  }
  return failures
}

function baseline(): OutboxPayloadBaseline {
  const path = fileURLToPath(new URL('./quality/outbox-payload-contracts.json', import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as OutboxPayloadBaseline
}

async function registeredContracts(): Promise<OutboxPayloadContracts> {
  const [run, score, question, review, landing] = await Promise.all([
    import('../orchestrator/src/run/run-outbox.ts'),
    import('../orchestrator/src/score/score-outbox.ts'),
    import('../orchestrator/src/run/question-outbox.ts'),
    import('../orchestrator/src/review/review-outbox.ts'),
    import('../orchestrator/src/record/landing-outbox.ts'),
  ])
  return {
    run: run.RUN_RECORD_PAYLOAD_CONTRACT,
    score: score.SCORE_RECORD_PAYLOAD_CONTRACT,
    question: question.QUESTION_RECORD_PAYLOAD_CONTRACT,
    review: review.REVIEW_RECORD_PAYLOAD_CONTRACT,
    review_lens: review.REVIEW_LENS_RECORD_PAYLOAD_CONTRACT,
    review_finding: review.REVIEW_FINDING_RECORD_PAYLOAD_CONTRACT,
    review_read: review.REVIEW_READ_RECORD_PAYLOAD_CONTRACT,
    landing: landing.LANDING_RECORD_PAYLOAD_CONTRACT,
    landing_override: landing.LANDING_OVERRIDE_RECORD_PAYLOAD_CONTRACT,
    landing_review_carry: landing.LANDING_REVIEW_CARRY_RECORD_PAYLOAD_CONTRACT,
    landing_triage_snapshot: landing.LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_CONTRACT,
    contention: landing.CONTENTION_RECORD_PAYLOAD_CONTRACT,
    test_flake: landing.TEST_FLAKE_RECORD_PAYLOAD_CONTRACT,
  }
}

if (import.meta.main) {
  const failures = outboxPayloadContractFailures(baseline(), await registeredContracts())
  if (failures.length > 0) {
    console.error(
      `outbox payload contract check failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    )
    process.exit(1)
  }
}
