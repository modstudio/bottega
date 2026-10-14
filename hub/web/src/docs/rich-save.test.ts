import { expect, test } from 'bun:test'
import type { JSONContent } from '@tiptap/core'
import { Node } from '@tiptap/pm/model'
import { richSchema } from './rich-extensions.ts'
import { parseRichDocument, saveRichDocument } from './rich-save.ts'

const table = '| Name | Price |\n| --- | --- |\n| Seat | 10 |\n'
const mermaid = '```mermaid\nflowchart LR\nA-->B\n```\n'
const alert = '> [!NOTE]\n> Keep the receipt.\n'
const directive = ':::section{audience=technical}\nShown to builders.\n:::\n'
const definition = 'See the [spec][foo].\n\n[foo]: /spec\n'
const comment = 'Before.\n\n<!-- not published -->\n\nAfter.\n'
const frontmatter = '---\ntitle: Pricing\n---\n\nThe fare.\n'
const leadingTitle = '# Product pricing\n\nThe fare is public.\n'
const wrapped = 'This paragraph is\nhard wrapped onto two lines.\n'
const blanks = 'First block.\n\n\n\nSecond block.\n'

const fixtures: Record<string, string> = {
  table,
  mermaid,
  alert,
  directive,
  definition,
  comment,
  frontmatter,
  leadingTitle,
  wrapped,
  blanks,
}

function clone(nodes: JSONContent[]): JSONContent[] {
  return structuredClone(nodes)
}

function firstParagraph(nodes: JSONContent[]): JSONContent {
  const paragraph = nodes.find((node) => node.type === 'paragraph')
  if (!paragraph) throw new Error('expected a paragraph')
  return paragraph
}

function setParagraphText(nodes: JSONContent[], text: string) {
  const paragraph = firstParagraph(nodes)
  paragraph.content = [{ type: 'text', text }]
}

test('a save with no edits returns the original byte-for-byte', () => {
  for (const [name, markdown] of Object.entries(fixtures)) {
    const saved = saveRichDocument(markdown, parseRichDocument(markdown))
    expect(saved, name).toBe(markdown)
  }
})

test("editing one paragraph changes only that paragraph's lines", () => {
  const rest = `${mermaid}\n${alert}\n${table}\n<!-- not published -->\n\n[foo]: /spec\n`
  const markdown = `Alpha line.\n\n${rest}`
  const nodes = clone(parseRichDocument(markdown))
  setParagraphText(nodes, 'Alpha line extra.')
  const saved = saveRichDocument(markdown, nodes)
  expect(saved).toBe(`Alpha line extra.\n\n${rest}`)
})

test('deleting a block removes only it', () => {
  const markdown = 'Keep this.\n\nDrop this.\n'
  const nodes = clone(parseRichDocument(markdown)).filter((_, index) => index !== 1)
  expect(saveRichDocument(markdown, nodes)).toBe('Keep this.\n')
})

test('inserting a paragraph between two blocks leaves both untouched', () => {
  const markdown = 'Left wrap\nstays.\n\nRight wrap\nstays.\n'
  const nodes = clone(parseRichDocument(markdown))
  nodes.splice(1, 0, { type: 'paragraph', content: [{ type: 'text', text: 'Inserted.' }] })
  expect(saveRichDocument(markdown, nodes)).toBe(
    'Left wrap\nstays.\n\nInserted.\n\nRight wrap\nstays.\n',
  )
})

test('an ampersand survives an edit as &', () => {
  const markdown = 'A & B together.\n'
  const nodes = clone(parseRichDocument(markdown))
  setParagraphText(nodes, 'A & B together still.')
  expect(saveRichDocument(markdown, nodes)).toBe('A & B together still.\n')
})

test('a leading title stays out of the editable nodes and is re-emitted on save', () => {
  const nodes = parseRichDocument(leadingTitle)
  expect(nodes.some((node) => node.type === 'heading' && node.attrs?.level === 1)).toBe(false)
  const edited = clone(nodes)
  setParagraphText(edited, 'The fare is public now.')
  expect(saveRichDocument(leadingTitle, edited)).toBe(
    '# Product pricing\n\nThe fare is public now.\n',
  )
})

test('untouched tables, links and lists survive an edit made in the editor', () => {
  const rest = `${table}\nSee [the spec](https://example.com/spec).\n\n1. one\n2. two\n`
  const markdown = `Intro line.\n\n${rest}`
  // The editor's document carries every schema default; the parse alone does not.
  const nodes = Node.fromJSON(richSchema(), {
    type: 'doc',
    content: parseRichDocument(markdown),
  }).toJSON().content as JSONContent[]
  setParagraphText(nodes, 'Intro line changed.')
  expect(saveRichDocument(markdown, nodes)).toBe(`Intro line changed.\n\n${rest}`)
})
