export type FenceUse = 'article-list' | 'diagram' | 'highlight' | 'plain'

/** Which treatment a fenced block receives, from the first word of its info string. */
export function fenceUse(language: string | undefined): FenceUse {
  const lang = (language ?? '').trim().split(/[ \t]/, 1)[0]!.toLowerCase()
  if (lang === '') return 'plain'
  if (lang === 'articles') return 'article-list'
  if (lang === 'mermaid') return 'diagram'
  return 'highlight'
}
