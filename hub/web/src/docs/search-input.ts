import type { DocsAudience } from './types.ts'

export function docsSearchInputs(
  query: string,
  audience: DocsAudience,
  subject: string | undefined,
  includeDrafts: boolean,
) {
  return {
    local: { query, audience, subject, includeDrafts },
    hosted: { query, audience, subject, includeDrafts, acrossReadableSpaces: true as const },
    public: { query },
  }
}
