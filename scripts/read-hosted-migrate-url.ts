import { PLATFORM_SLUG } from '../shared/brand.ts'
import { readEnvValuesWithHosted } from '../shared/env-source.ts'
import { secretResolutionFailure } from '../shared/secret-resolution-failure.ts'

const name = 'BOTTEGA_RECORD_MIGRATE_URL'

if (process.stdout.isTTY) {
  console.error('REFUSE: this command writes a credential for command substitution only')
  process.exit(1)
}

let value: string | undefined
try {
  value = (await readEnvValuesWithHosted([name]))[name]
} catch (error) {
  console.error(
    secretResolutionFailure(error) ??
      `sealed ${name} could not be read\ncleared by: ${PLATFORM_SLUG} record doctor`,
  )
  process.exit(2)
}

if (!value) process.exit(1)
process.stdout.write(value)
