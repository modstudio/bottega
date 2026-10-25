import { readEnvValuesWithHosted } from '../shared/env-source.ts'

const name = 'BOTTEGA_RECORD_MIGRATE_URL'

if (process.stdout.isTTY) {
  console.error('REFUSE: this command writes a credential for command substitution only')
  process.exit(1)
}

let value: string | undefined
try {
  value = (await readEnvValuesWithHosted([name]))[name]
} catch {
  process.exit(1)
}

if (!value) process.exit(1)
process.stdout.write(value)
