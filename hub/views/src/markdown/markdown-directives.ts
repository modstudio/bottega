type DirectiveNode = {
  type?: string
  name?: string
  value?: string
  attributes?: Record<string, string | null | undefined> | null
  children?: DirectiveNode[]
  data?: Record<string, unknown>
}

function plainText(node: DirectiveNode): string {
  return node.value ?? (node.children ?? []).map(plainText).join('')
}

/**
 * The source an inline or leaf directive was parsed from. Only `section` containers are
 * directives here, so any other `:name` is prose, such as the minutes of `16:41`.
 */
function directiveSource(node: DirectiveNode): string {
  const marker = node.type === 'leafDirective' ? '::' : ':'
  const label = node.children?.length ? `[${node.children.map(plainText).join('')}]` : ''
  const attributes = Object.entries(node.attributes ?? {})
  const block = attributes.length
    ? `{${attributes.map(([key, value]) => (value ? `${key}="${value}"` : key)).join(' ')}}`
    : ''
  return `${marker}${node.name ?? ''}${label}${block}`
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
  return (tree: DirectiveNode) => {
    const visit = (node: DirectiveNode) => {
      if (node.type === 'containerDirective' && node.name === 'section') {
        node.data = sectionData(node)
      }
      node.children = node.children?.map((child) =>
        child.type === 'textDirective' || child.type === 'leafDirective'
          ? { type: 'text', value: directiveSource(child) }
          : child,
      )
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree)
  }
}
