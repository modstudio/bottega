import { parseShard } from '../../shared/shard.ts'

export function gateTestArguments(argv: readonly string[]): {
  shardArguments: string[]
  timeoutArguments: string[]
} {
  const shardArguments: string[] = []
  const timeoutArguments: string[] = []
  for (const argument of argv) {
    if (/^--shard=\d+\/\d+$/.test(argument) && shardArguments.length === 0) {
      try {
        parseShard(argument.slice('--shard='.length))
      } catch (error) {
        throw new Error(`test:gate shard ${error instanceof Error ? error.message : error}`)
      }
      shardArguments.push(argument)
      continue
    }
    if (/^--timeout=[1-9]\d*$/.test(argument) && timeoutArguments.length === 0) {
      timeoutArguments.push(argument)
      continue
    }
    throw new Error('test:gate accepts only one --shard=M/N and one --timeout=N')
  }
  return { shardArguments, timeoutArguments }
}
