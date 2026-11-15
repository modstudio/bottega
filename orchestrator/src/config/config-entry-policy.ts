// concern: config entry policy
/** Decides config homes and validates plain hosted setting values. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type ConfigHome,
  configHomes,
  DISPLAY_TIMEZONE_KEY,
  isDisplayTimezone,
  isSubscriptionPriceKey,
  validateAutonomyEntry,
} from '../../../shared/machine-config.ts'

function acceptedHomes(key: string): readonly ConfigHome[] {
  const homes = configHomes(key)
  if (homes) return homes
  throw new Error(
    `refusing config key ${key}: accepted families are machine catalogue keys, display.timezone, autonomy.*, and subscription.<harness>.monthly_usd; inspect machine keys with \`${PLATFORM_SLUG} machine config list --machine\``,
  )
}

function homeLabel(home: ConfigHome): string {
  return home === 'machine' ? 'machine' : `hosted ${home} scope`
}

export function setRemedy(key: string, home: ConfigHome): string {
  const flag = home === 'machine' ? '--machine ' : home === 'space' ? '--space ' : ''
  return `${PLATFORM_SLUG} machine config set ${flag}${key} <value>`
}

function getRemedy(key: string): string {
  const homes = configHomes(key) ?? []
  const flags = [
    ...(homes.includes('machine') ? ['--machine'] : []),
    ...(homes.includes('space') ? ['--space'] : []),
  ]
  const selector = homes.includes('user')
    ? flags.length
      ? ` [${flags.join('|')}]`
      : ''
    : ` ${flags.join('|')}`
  return `${PLATFORM_SLUG} machine config get${selector} ${key}`
}

export function configHome(
  key: string,
  requested?: ConfigHome,
  operation: 'get' | 'set' = 'set',
): ConfigHome {
  const homes = acceptedHomes(key)
  const chosen = requested ?? homes[0]!
  if (homes.includes(chosen)) return chosen
  const home = homes[0]!
  const remedy =
    operation === 'get'
      ? `read it with \`${getRemedy(key)}\``
      : `write it with \`${setRemedy(key, home)}\``
  throw new Error(
    `refusing config key ${key} in ${homeLabel(chosen)}: its home is ${homeLabel(home)}; ${remedy}`,
  )
}

export function validateHostedValue(key: string, value: string): void {
  if (key === DISPLAY_TIMEZONE_KEY) {
    if (!isDisplayTimezone(value)) {
      throw new Error(
        `refusing ${DISPLAY_TIMEZONE_KEY} ${value}: not an IANA time zone; e.g. ${PLATFORM_SLUG} machine config set ${DISPLAY_TIMEZONE_KEY} America/New_York`,
      )
    }
    return
  }
  if (key.startsWith('autonomy.')) {
    validateAutonomyEntry(key, value)
    return
  }
  if (isSubscriptionPriceKey(key)) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0)
      throw new Error(`refusing config key ${key}: value must be a non-negative number`)
  }
}
