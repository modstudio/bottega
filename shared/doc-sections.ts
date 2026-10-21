// concern: document-sections
/** Pure parsing, validation, and audience projection for marked document sections. */
import { directiveFromMarkdown } from 'mdast-util-directive'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { directive } from 'micromark-extension-directive'
import { DOC_AUDIENCES, type DocAudience, type DocAudiences } from './docs.ts'

type Position = { start: { line: number; offset?: number }; end: { line: number; offset?: number } }
type Node = {
  type: string
  name?: string
  attributes?: Record<string, string | null> | null
  children?: Node[]
  position?: Position
}

export type DocSection = {
  audiences: DocAudience[]
  attributes: Record<string, string | null>
  firstLine: string
  start: number
  end: number
  openingEnd: number
  closingStart: number
  closed: boolean
  nested: boolean
}

function docSectionAudiences(
  attributes: Record<string, string | null> | null | undefined,
): string[] {
  const value = attributes?.audience
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((audience) => audience.trim())
    .filter(Boolean)
}

function lineStart(body: string, offset: number): number {
  return body.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
}

function lineEnd(body: string, offset: number): number {
  const newline = body.indexOf('\n', offset)
  return newline < 0 ? body.length : newline + 1
}

function sourceLine(body: string, line: number): string {
  return body.split('\n')[line - 1] ?? ''
}

function parseDoc(body: string): Node {
  return fromMarkdown(body, {
    extensions: [directive()],
    mdastExtensions: [directiveFromMarkdown()],
  }) as Node
}

function sectionsFromTree(body: string, tree: Node): DocSection[] {
  const sections: DocSection[] = []
  const visit = (node: Node, insideSection: boolean) => {
    const marked = node.type === 'containerDirective' && node.name === 'section'
    if (marked && node.position) {
      const start = node.position.start.offset ?? 0
      const end = node.position.end.offset ?? body.length
      const closed = /^(?:\s*>)*\s*:{3,}\s*$/.test(sourceLine(body, node.position.end.line))
      const openingEnd = lineEnd(body, start)
      const closingStart = closed ? lineStart(body, end) : end
      sections.push({
        audiences: docSectionAudiences(node.attributes) as DocAudience[],
        attributes: node.attributes ?? {},
        firstLine: body.slice(lineStart(body, start), lineEnd(body, start)).trimEnd(),
        start: lineStart(body, start),
        end: lineEnd(body, end),
        openingEnd,
        closingStart,
        closed,
        nested: insideSection,
      })
    }
    for (const child of node.children ?? []) visit(child, insideSection || marked)
  }
  visit(tree, false)
  return sections
}

function invalidSectionMarkLine(body: string, tree: Node): number | null {
  let found: number | null = null
  const visit = (node: Node) => {
    if (found !== null) return
    const directiveNamedSection = node.name?.toLowerCase() === 'section'
    if (
      node.position &&
      ((node.type === 'containerDirective' && directiveNamedSection && node.name !== 'section') ||
        ((node.type === 'leafDirective' || node.type === 'textDirective') && directiveNamedSection))
    ) {
      found = node.position.start.line
      return
    }
    if (node.type === 'paragraph' && node.position) {
      const lines = body
        .slice(node.position.start.offset ?? 0, node.position.end.offset ?? body.length)
        .split('\n')
      const index = lines.findIndex((line) => /^:{2,}\s*section\b/i.test(line))
      if (index >= 0) {
        found = node.position.start.line + index
        return
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return found
}

/** Parse all marked sections. Other directive kinds are deliberately ignored. */
export function docSections(body: string): DocSection[] {
  return sectionsFromTree(body, parseDoc(body))
}

export function docSectionRefusal(body: string, documentAudiences: DocAudiences): string | null {
  const tree = parseDoc(body)
  const invalidLine = invalidSectionMarkLine(body, tree)
  if (invalidLine !== null) {
    return `line ${invalidLine} looks like a section mark but is not valid; use :::section{audience="…"}`
  }
  const sections = sectionsFromTree(body, tree)
  const nested = sections.find((section) => section.nested)
  if (nested) {
    return `section ${JSON.stringify(nested.firstLine)} is nested inside another marked section; move it outside the other section`
  }
  for (const section of sections) {
    const named = `section ${JSON.stringify(section.firstLine)}`
    const keys = Object.keys(section.attributes)
    if (keys.some((key) => key !== 'audience')) {
      return `${named} has an attribute other than audience; remove every other attribute`
    }
    if (!section.audiences.length) {
      return `${named} names no audience; set audience to one or more comma-separated document audiences`
    }
    const unknown = section.audiences.find(
      (audience) => !DOC_AUDIENCES.includes(audience as DocAudience),
    )
    if (unknown) {
      return `${named} names unknown audience ${JSON.stringify(unknown)}; use ${DOC_AUDIENCES.join(', ')}`
    }
    const absent = section.audiences.find((audience) => !documentAudiences.includes(audience))
    if (absent) {
      return `${named} names audience ${JSON.stringify(absent)} that the document does not list; add it to the document audiences or remove it from the section`
    }
    if (!section.closed) {
      return `${named} is not closed; add a closing ::: fence`
    }
  }
  return null
}

export function docAudienceRefusal(
  address: string,
  documentAudiences: DocAudiences,
  audience: DocAudience,
): string | null {
  return documentAudiences.includes(audience)
    ? null
    : `document ${address} does not list audience ${JSON.stringify(audience)}; choose one of ${documentAudiences.join(', ')}`
}

export function assertDocSections(body: string, documentAudiences: DocAudiences): void {
  const refusal = docSectionRefusal(body, documentAudiences)
  if (refusal) throw new Error(refusal)
}

/** Return ordinary Markdown containing only the sections visible to one audience. */
export function docBodyForAudience(body: string, audience: DocAudience): string {
  const edits: Array<{ start: number; end: number; value: string }> = []
  for (const section of docSections(body)) {
    if (!section.audiences.includes(audience)) {
      edits.push({ start: section.start, end: section.end, value: '' })
    } else {
      edits.push({ start: section.closingStart, end: section.end, value: '' })
      edits.push({ start: section.start, end: section.openingEnd, value: '' })
    }
  }
  let result = body
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end)
  }
  return result
}
