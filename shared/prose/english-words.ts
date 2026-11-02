// concern: prose
/** Lazy adapter for the embedded English word list. */

import englishWordsText from '../../node_modules/word-list/words.txt' with { type: 'text' }

let englishWords: Set<string> | null = null

function loadedEnglishWords(): Set<string> {
  if (englishWords === null) englishWords = new Set(englishWordsText.split('\n'))
  return englishWords
}

export function isEnglishWord(word: string): boolean {
  return loadedEnglishWords().has(word)
}
