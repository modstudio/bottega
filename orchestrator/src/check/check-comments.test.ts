import { describe, expect, test } from 'bun:test'
import {
  type CommentSource,
  commentFindings,
  commentsInSource,
  DEFAULT_COMMENT_HISTORY_PHRASES,
} from './check-comments.ts'

const comment = (text: string, line = 1): CommentSource => ({
  file: 'fixture.ts',
  line,
  text,
})

describe('comment hygiene decisions', () => {
  test('task keys use only the registered prefixes', () => {
    const findings = commentFindings(comment('// UTF-8 and DEV-12'), {
      taskKeyPrefixes: ['DEV'],
    })

    expect(findings.map((finding) => finding.match)).toEqual(['DEV-12'])
  })

  test('default and custom phrase lists are distinct', () => {
    expect(
      commentFindings(comment('// this used to work'), {
        historyPhrases: DEFAULT_COMMENT_HISTORY_PHRASES,
      }).map((finding) => finding.match),
    ).toEqual(['used to'])
    expect(
      commentFindings(comment('// archival choice'), { historyPhrases: ['archival choice'] }).map(
        (finding) => finding.match,
      ),
    ).toEqual(['archival choice'])
    expect(
      commentFindings(comment('// this used to work'), { historyPhrases: ['archival choice'] }),
    ).toEqual([])
  })

  test('a history allow marker requires a reason', () => {
    expect(
      commentFindings(comment('// used to is clearest; history-ok: describes the API term'), {
        historyPhrases: ['used to'],
      }),
    ).toEqual([])

    expect(
      commentFindings(comment('/* history-ok: */'), { historyPhrases: ['used to'] }).map(
        (finding) => finding.rule,
      ),
    ).toEqual(['history-allow'])
  })

  test('multiline findings retain the source line', () => {
    expect(
      commentFindings(comment('/* first line\n * DEV-12 */', 8), {
        taskKeyPrefixes: ['DEV'],
      })[0]?.line,
    ).toBe(9)
  })
})

describe('ast-grep comment extraction', () => {
  const fixtures = [
    ['TypeScript', 'fixture.ts', 'const text = "DEV-12"\n// DEV-12', '// DEV-12'],
    ['TSX', 'fixture.tsx', 'const node = <div>{"DEV-12"}</div>\n{/* DEV-12 */}', '/* DEV-12 */'],
    ['JavaScript', 'fixture.js', 'const text = "DEV-12"\n/* DEV-12 */', '/* DEV-12 */'],
    ['PHP', 'fixture.php', '<?php $text = "DEV-12";\n# DEV-12', '# DEV-12'],
    ['shell', 'fixture.sh', 'text="DEV-12"\n# DEV-12', '# DEV-12'],
    ['Python', 'fixture.py', 'text = "DEV-12"\n# DEV-12', '# DEV-12'],
  ] as const

  for (const [language, file, source, expected] of fixtures) {
    test(`extracts ${language} comments without string literals`, () => {
      const comments = commentsInSource(file, source)

      expect(comments.map((value) => value.text)).toEqual([expected])
      expect(
        comments.flatMap((value) =>
          commentFindings(value, {
            taskKeyPrefixes: ['DEV'],
            historyPhrases: ['used to'],
          }),
        ),
      ).toHaveLength(1)
    })
  }

  test('a string containing a history phrase is not a comment', () => {
    const comments = commentsInSource('fixture.ts', 'const text = "this used to work"')

    expect(comments).toEqual([])
  })
})
