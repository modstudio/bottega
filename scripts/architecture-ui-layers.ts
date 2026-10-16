/**
 * The hub dashboard's component layers, lowest first. A folder under
 * `hub/ui/src/` belongs to exactly one layer and may import only its own
 * layer or a lower one. `behavior` holds hooks and pure helpers with no markup;
 * `primitives` are single controls; `overlays` open above the page; `patterns`
 * compose controls into one reusable piece; `layout` arranges a screen.
 */
const uiLayers: { name: string; folders: string[] }[] = [
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

const uiFolders = (folders: string[]) => `^hub/ui/src/(?:${folders.join('|')})/`

type UiArchitectureRule = {
  name: string
  severity: 'error'
  comment: string
  from: { path: string; pathNot?: string[] }
  to: { path?: string; dependencyTypes?: string[]; couldNotResolve?: boolean }
}

export function uiArchitectureRules(
  dependencyPath: (target: string) => string,
  packageName: string,
): UiArchitectureRule[] {
  return [
    {
      name: 'hub-ui-is-a-leaf',
      severity: 'error',
      comment:
        'The component library knows nothing of data, routing or hub mode and imports its own modules through relative paths.',
      from: { path: '^hub/ui/' },
      to: {
        path: [
          '^hub/(?:web|src)/',
          '^@/(?:trpc|lib/hub-mode)',
          '^@tanstack/(?:react-query|react-router)$',
          '^@trpc/',
          dependencyPath('@tanstack/react-query'),
          dependencyPath('@tanstack/react-router'),
          dependencyPath('@trpc/client'),
          dependencyPath('@trpc/server'),
          dependencyPath('@trpc/tanstack-react-query'),
        ].join('|'),
      },
    },
    {
      name: 'hub-ui-folder-has-a-layer',
      severity: 'error',
      comment: 'Every ui/ folder is declared in uiLayers in architecture-ui-layers.ts.',
      from: {
        path: '^hub/ui/src/',
        pathNot: uiFolders(uiLayers.flatMap((layer) => layer.folders)),
      },
      to: {},
    },
    ...uiLayers.slice(0, -1).map((layer, index) => ({
      name: `hub-ui-${layer.name}-imports-no-higher-layer`,
      severity: 'error' as const,
      comment: `A ${layer.name} folder may import only its own or a lower ui layer.`,
      from: { path: uiFolders(layer.folders) },
      to: { path: uiFolders(uiLayers.slice(index + 1).flatMap((higher) => higher.folders)) },
    })),
    {
      name: 'hub-ui-source-imports-use-package-exports',
      severity: 'error',
      comment: 'Code outside hub-ui imports it through package exports, never source paths.',
      from: { path: '^(?!hub/ui/)' },
      to: { path: '^hub/ui/src/', dependencyTypes: ['local'] },
    },
    {
      name: 'hub-ui-package-imports-resolve-declared-exports',
      severity: 'error',
      comment: 'Every hub-ui package import names a declared export subpath.',
      from: { path: '^(?!hub/ui/)' },
      to: { path: `^${packageName}/`, couldNotResolve: true },
    },
  ]
}
