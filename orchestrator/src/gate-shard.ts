export function gateShardArguments(argv: readonly string[]): string[] {
  if (argv.length === 0) return []
  if (argv.length !== 1 || !/^--shard=\d+\/\d+$/.test(argv[0]!)) {
    throw new Error('test:gate accepts only --shard=M/N')
  }
  const [index, total] = argv[0]!.slice('--shard='.length).split('/').map(Number)
  if (total! < 1 || index! < 1 || index! > total!) {
    throw new Error('test:gate shard must satisfy 1 <= M <= N')
  }
  return [argv[0]!]
}
