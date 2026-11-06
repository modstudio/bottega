// concern: answer-value-args
/** Lexically extracts the CLI's typed answer token without consulting storage. */

export type AnswerValueArgs = {
  argv: string[]
  questionIdentifier?: string
  raw?: string
}

function takeValue(argv: string[]): { argv: string[]; raw?: string } {
  const remaining: string[] = []
  let raw: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument !== '--value' && !argument.startsWith('--value=')) {
      remaining.push(argument)
      continue
    }
    if (raw !== undefined) throw new Error('--value may be supplied only once')
    raw = argument === '--value' ? argv[++index] : argument.slice('--value='.length)
    if (!raw) throw new Error('--value needs a value')
  }
  return { argv: remaining, raw }
}

function selectedQuestionIdentifier(identifiers: string[]): string | undefined {
  if (identifiers.length > 1) throw new Error('--value may answer only one question at a time')
  return identifiers[0]
}

export function answerValueArgs(
  argv: string[],
  questionIdentifiers: string[],
): AnswerValueArgs {
  const taken = takeValue(argv)
  if (taken.raw === undefined) return { argv: taken.argv }
  return {
    argv: taken.argv,
    questionIdentifier: selectedQuestionIdentifier(questionIdentifiers),
    raw: taken.raw,
  }
}
