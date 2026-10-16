import { parseShard } from '../../shared/shard.ts'

export function gateShardArguments(argv: readonly string[]): string[] {
  if (argv.length === 0) return []
  if (argv.length !== 1 || !/^--shard=\d+\/\d+$/.test(argv[0]!)) {
    throw new Error('test:gate accepts only --shard=M/N')
  }
  try {
    parseShard(argv[0]!.slice('--shard='.length))
  } catch (error) {
    throw new Error(`test:gate shard ${error instanceof Error ? error.message : error}`)
  }
  return [argv[0]!]
}
