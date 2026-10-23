import { readEnvValues } from '../shared/env-values.ts'

const name = 'BOTTEGA_RECORD_MIGRATE_URL'

if (process.stdout.isTTY) {
  console.error('REFUSE: this command writes a credential for command substitution only')
  process.exit(1)
}

const value = readEnvValues([name])[name]

if (!value) process.exit(1)
process.stdout.write(value)
