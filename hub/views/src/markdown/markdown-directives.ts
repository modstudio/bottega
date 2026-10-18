type DirectiveNode = {
  type?: string
  name?: string
  value?: string
  attributes?: Record<string, string | null | undefined> | null
  children?: DirectiveNode[]
  data?: Record<string, unknown>
  position?: { start: { offset?: number }; end: { offset?: number } }
}

/**
 * The exact source an inline or leaf directive was parsed from. Only `section` containers are
 * directives here, so any other `:name` is prose, such as the minutes of `16:41`.
 */
function directiveSource(node: DirectiveNode, source: string): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return `:${node.name ?? ''}`
  return source.slice(start, end)
}

function sectionData(node: DirectiveNode): Record<string, unknown> {
  const audience = node.attributes?.audience
  const audiences =
    typeof audience === 'string'
      ? audience
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : []
  return {
    ...node.data,
    hName: 'div',
    hProperties: { 'data-doc-section-audiences': audiences.join(',') },
  }
}

/** Renders `:::section` containers and returns every other directive to its literal text. */
export function docDirectives() {
  return (tree: DirectiveNode, file: { value: unknown }) => {
    const source = String(file.value)
    const visit = (node: DirectiveNode) => {
      if (node.type === 'containerDirective' && node.name === 'section') {
        node.data = sectionData(node)
      }
      node.children = node.children?.map((child) =>
        child.type === 'textDirective' || child.type === 'leafDirective'
          ? { type: 'text', value: directiveSource(child, source) }
          : child,
      )
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree)
  }
}
