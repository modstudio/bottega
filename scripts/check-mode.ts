export const CHECK_LEG_NAMES = [
  'orchestrator',
  'hub',
  'hub/web',
  'hub/deploy/site',
  'retrieval',
] as const

export type CheckLegName = (typeof CHECK_LEG_NAMES)[number]
export type CheckShard = { index: number; total: number; value: string }
export type CheckArguments = {
  mode: 'static' | 'suite'
  only?: CheckLegName
  shard?: CheckShard
}

function parseShard(value: string): CheckShard {
  const match = value.match(/^(\d+)\/(\d+)$/)
  if (!match) throw new Error(`invalid --shard=${value}; expected M/N`)
  const index = Number(match[1])
  const total = Number(match[2])
  if (total < 1 || index < 1 || index > total) {
    throw new Error(`invalid --shard=${value}; M and N must satisfy 1 <= M <= N`)
  }
  return { index, total, value }
}

export function parseCheckArguments(argv: readonly string[]): CheckArguments {
  let suite = false
  let only: CheckLegName | undefined
  let shard: CheckShard | undefined
  for (const argument of argv) {
    if (argument === '--suite') {
      if (suite) throw new Error('--suite may be provided only once')
      suite = true
      continue
    }
    if (argument.startsWith('--only=')) {
      if (only) throw new Error('--only may be provided only once')
      const value = argument.slice('--only='.length)
      if (!CHECK_LEG_NAMES.includes(value as CheckLegName)) {
        throw new Error(`invalid --only=${value}; expected one of ${CHECK_LEG_NAMES.join(', ')}`)
      }
      only = value as CheckLegName
      continue
    }
    if (argument.startsWith('--shard=')) {
      if (shard) throw new Error('--shard may be provided only once')
      shard = parseShard(argument.slice('--shard='.length))
      continue
    }
    throw new Error(`unknown check argument ${JSON.stringify(argument)}`)
  }
  if (!suite && (only || shard)) throw new Error('--only and --shard require --suite')
  if (shard && only && only !== 'orchestrator') {
    throw new Error('--shard applies only to the orchestrator suite')
  }
  return {
    mode: suite ? 'suite' : 'static',
    ...(only ? { only } : {}),
    ...(shard ? { shard } : {}),
  }
}

export function selectedCheckLegs(options: CheckArguments): CheckLegName[] {
  return options.only ? [options.only] : [...CHECK_LEG_NAMES]
}

export function runsRootSuiteTests(options: CheckArguments): boolean {
  return (
    options.mode === 'suite' &&
    (!options.only || options.only === 'orchestrator') &&
    (!options.shard || options.shard.index === 1)
  )
}
