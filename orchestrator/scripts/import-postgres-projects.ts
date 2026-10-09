#!/usr/bin/env bun
import { importProjects } from '../src/postgres/postgres-import.ts'
import { currentRecordSession } from '../src/record/record-session.ts'

function required(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

const databaseUrl = required('--database-url')
const current = await currentRecordSession(databaseUrl)
const result = await importProjects({
  orchDb: required('--orch-db'),
  hubDb: required('--hub-db'),
  databaseUrl,
  spaceId: required('--space-id'),
  principal: { userId: current.user.id },
})

console.log(JSON.stringify(result))
