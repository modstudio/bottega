#!/usr/bin/env bun
import { importProjects } from '../src/postgres/postgres-import.ts'

function required(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

const result = await importProjects({
  orchDb: required('--orch-db'),
  hubDb: required('--hub-db'),
  databaseUrl: required('--database-url'),
  spaceId: required('--space-id'),
})

console.log(JSON.stringify(result))
