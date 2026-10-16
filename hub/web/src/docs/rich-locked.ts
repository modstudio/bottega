import { Node } from '@tiptap/core'
import { isGithubAlertBlock } from '@/components/markdown/markdown-alerts'
import { fenceUse } from '@/components/markdown/markdown-fences'

export const LOCKED_BLOCK_NAME = 'lockedBlock'

type MarkedToken = {
  type: string
  raw: string
  lang?: string
  depth?: number
}

function matchFrontmatter(src: string): string | undefined {
  const match = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(src)
  return match?.[0]
}

function matchDirectiveContainer(src: string): string | undefined {
  const firstNl = src.indexOf('\n')
  if (firstNl < 0) return
  const open = /^(:{3,})[^\n]*$/.exec(src.slice(0, firstNl))
  if (!open) return
  const fenceLen = open[1]!.length
  let pos = firstNl + 1
  while (pos <= src.length) {
    const nextNl = src.indexOf('\n', pos)
    const lineEnd = nextNl < 0 ? src.length : nextNl
    const line = src.slice(pos, lineEnd)
    const colons = /^(:{3,})[ \t]*$/.exec(line)
    if (colons && colons[1]!.length >= fenceLen) {
      return src.slice(0, nextNl < 0 ? src.length : nextNl + 1)
    }
    if (nextNl < 0) return
    pos = nextNl + 1
  }
}

function isHtmlComment(raw: string): boolean {
  return /^<!--[\s\S]*-->$/.test(raw.replace(/\n+$/, ''))
}

/** Whether a marked token is a construct the rich editor must not rewrite. */
export function isLockedToken(token: MarkedToken): boolean {
  if (token.type === 'frontmatter' || token.type === 'directive') return true
  if (
    token.type === 'code' &&
    (fenceUse(token.lang) === 'diagram' || fenceUse(token.lang) === 'article-list')
  )
    return true
  if (token.type === 'blockquote' && isGithubAlertBlock(token.raw)) return true
  if (token.type === 'html' && !isHtmlComment(token.raw)) return true
  return false
}

/** Whether a marked token should be carried through without becoming a node. */
export function isSilentToken(token: MarkedToken): boolean {
  if (token.type === 'def') return true
  if (token.type === 'html' && isHtmlComment(token.raw)) return true
  return false
}

export function lockedNode(source: string) {
  return { type: LOCKED_BLOCK_NAME, attrs: { source } }
}

export const LockedBlock = Node.create({
  name: LOCKED_BLOCK_NAME,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { source: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'div[data-locked-block]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, 'data-locked-block': '' }]
  },
  renderMarkdown(node) {
    return typeof node.attrs?.source === 'string' ? node.attrs.source : ''
  },
  markdownTokenizer: {
    name: 'lockedFence',
    level: 'block',
    start(src: string) {
      if (src.startsWith('---') || src.startsWith(':::')) return 0
      return -1
    },
    tokenize(src: string, tokens: unknown[]) {
      if (tokens.length === 0) {
        const frontmatter = matchFrontmatter(src)
        if (frontmatter) return { type: 'frontmatter', raw: frontmatter }
      }
      const directive = matchDirectiveContainer(src)
      if (directive) return { type: 'directive', raw: directive }
    },
  },
})
