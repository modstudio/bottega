export type FenceUse = 'diagram' | 'highlight' | 'plain'

/** Which treatment a fenced block's info language receives. */
export function fenceUse(language: string | undefined): FenceUse {
  const lang = language?.trim().toLowerCase() ?? ''
  if (lang === '') return 'plain'
  if (lang === 'mermaid') return 'diagram'
  return 'highlight'
}
