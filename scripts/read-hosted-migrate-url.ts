import { readEnvValues } from '../shared/env-values.ts'

const name = 'ORCH_RECORD_MIGRATE_URL'
const value = readEnvValues([name])[name]

if (!value) process.exit(1)
process.stdout.write(value)
