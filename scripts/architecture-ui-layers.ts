/**
 * The hub dashboard's component layers, lowest first. A folder under
 * `hub/web/src/ui/` belongs to exactly one layer and may import only its own
 * layer or a lower one. `behavior` holds hooks and pure helpers with no markup;
 * `primitives` are single controls; `overlays` open above the page; `patterns`
 * compose controls into one reusable piece; `layout` arranges a screen.
 */
export const uiLayers: { name: string; folders: string[] }[] = [
  { name: 'behavior', folders: ['state', 'dom', 'text'] },
  {
    name: 'primitives',
    folders: [
      'badge',
      'identifier',
      'button',
      'field',
      'radio-rows',
      'checkbox',
      'switch',
      'spinner',
      'kbd',
      'separator',
    ],
  },
  {
    name: 'overlays',
    folders: ['popover', 'tooltip', 'menu', 'listbox', 'dialog', 'sheet', 'bottom-sheet', 'toast'],
  },
  {
    name: 'patterns',
    folders: [
      'tabs',
      'segmented',
      'empty-state',
      'callout',
      'stat',
      'table',
      'page-header',
      'project-mark',
      'pagination',
      'form-layout',
    ],
  },
  { name: 'layout', folders: ['shell', 'table-card', 'toolbar-band', 'companion'] },
]

export const uiFolders = (folders: string[]) => `^hub/web/src/ui/(?:${folders.join('|')})/`
