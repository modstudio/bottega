// concern: worker-question-jev
/** Pure combination of position-balanced Jev choice answers. */

import type { TypedQuestionAnswer } from '../../../shared/typed-question/client.ts'

type ChoiceAnswer = Extract<TypedQuestionAnswer, { choice: string }>

export type CombinedJevChoice = {
  answer: ChoiceAnswer | null
  fits: number | null
  orderFlipped: boolean | null
  bothOrdersAnswered: boolean
}

function argmax(probabilities: Record<string, number>): string | null {
  let best: string | null = null
  let maximum = -1
  for (const [option, probability] of Object.entries(probabilities)) {
    if (probability > maximum) {
      best = option
      maximum = probability
    }
  }
  return best
}

export function combineJevChoice(input: {
  options: readonly string[]
  forward?: TypedQuestionAnswer
  reversed?: TypedQuestionAnswer
  fits?: TypedQuestionAnswer
}): CombinedJevChoice {
  const forward = input.forward && 'choice' in input.forward ? input.forward : null
  const reversed = input.reversed && 'choice' in input.reversed ? input.reversed : null
  const fits = input.fits && 'noul' in input.fits ? input.fits.noul : null
  if (!forward || !reversed) {
    const available = forward ?? reversed
    return {
      answer: available,
      fits,
      orderFlipped: null,
      bothOrdersAnswered: false,
    }
  }
  const probabilities = Object.fromEntries(
    input.options.map((option) => [
      option,
      ((forward.probabilities[option] ?? 0) + (reversed.probabilities[option] ?? 0)) / 2,
    ]),
  )
  const forwardPick = argmax(forward.probabilities)
  const reversedPick = argmax(reversed.probabilities)
  const maximum = Math.max(...Object.values(probabilities))
  const tied = input.options.filter((option) => probabilities[option] === maximum)
  const choice = tied.includes(forward.choice) ? forward.choice : tied[0]!
  const chance = 1 / input.options.length
  return {
    answer: {
      choice,
      probabilities,
      confidence: (maximum - chance) / (1 - chance),
    },
    fits,
    orderFlipped: forwardPick !== reversedPick,
    bothOrdersAnswered: true,
  }
}
