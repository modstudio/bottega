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
      'app-mark',
      'avatar',
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
    folders: [
      'popover',
      'tooltip',
      'menu',
      'listbox',
      'dialog',
      'sheet',
      'bottom-sheet',
      'drawer',
      'toast',
    ],
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
      'card-list',
      'page-header',
      'project-mark',
      'pagination',
      'form-layout',
    ],
  },
  {
    name: 'layout',
    folders: ['shell', 'table-card', 'toolbar-band', 'companion', 'collection'],
  },
]

const hubUiLayerFolders = uiLayers.flatMap((layer) => layer.folders)
export const hubUiFolderLayerRuleName = 'hub-ui-folder-has-a-layer'

const hubUiLayerFolderSet = new Set(hubUiLayerFolders)
const HUB_UI_SOURCE_PREFIX = 'hub/ui/src/'
const TEST_SOURCE = /\.(?:test|spec)\.[cm]?tsx?$/

/** Whether a repository-relative hub-ui source path belongs to a declared location. */
export function isDeclaredHubUiSourceLocation(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  if (!normalized.startsWith(HUB_UI_SOURCE_PREFIX) || TEST_SOURCE.test(normalized)) return true
  const sourcePath = normalized.slice(HUB_UI_SOURCE_PREFIX.length)
  const slash = sourcePath.indexOf('/')
  if (slash < 1) return false
  const folder = sourcePath.slice(0, slash)
  return folder === 'styles' || hubUiLayerFolderSet.has(folder)
}

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
      name: 'hub-ui-stories-import-only-components-and-storybook',
      severity: 'error',
      comment:
        'Stories import their subject through a relative path and otherwise use only Storybook packages.',
      from: { path: '^hub/ui/src/.*\\.stories\\.tsx$' },
      to: {
        path: '^(?!hub/ui/src/|node_modules/.*/node_modules/(?:@storybook/|storybook/))',
      },
    },
    {
      name: 'hub-ui-stories-are-not-production-dependencies',
      severity: 'error',
      comment: 'Production and test modules never import Storybook stories.',
      from: { path: '^hub/ui/', pathNot: ['^hub/ui/src/.*\\.stories\\.tsx$'] },
      to: { path: '^hub/ui/src/.*\\.stories\\.tsx$' },
    },
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
      name: 'hub-ui-variant-dependencies-have-one-entry',
      severity: 'error',
      comment: 'Only the shared variant module imports tailwind-variants or tailwind-merge.',
      from: {
        path: '^(?!hub/ui/src/text/variant\\.ts$)',
        pathNot: ['^hub/ui/src/text/variant\\.ts$'],
      },
      to: {
        path: [
          dependencyPath('tailwind-variants'),
          dependencyPath('tailwind-merge'),
          '^tailwind-(?:variants|merge)$',
        ].join('|'),
      },
    },
    {
      name: hubUiFolderLayerRuleName,
      severity: 'error',
      comment: 'Every ui/ folder is declared in uiLayers in architecture-ui-layers.ts.',
      from: {
        path: '^hub/ui/src/',
        pathNot: [uiFolders(hubUiLayerFolders)],
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

const hubViewFolders = [
  'docs',
  'markdown',
  'document-surface',
  'key-line',
  'insights',
  'detail-rail',
  'rail-section',
  'contents-list',
  'document-editor',
  'status-look',
  'task-history',
  'task-page',
  'measures',
  'machine-permissions',
  'password-reset',
  'project-colors',
  'projects',
  'reports',
  'reviews',
  'snapshot',
  'sign-in',
  'source-mark',
  'waiting-badge',
  'work-summary',
  'work-list',
]

const hubViewsFolderLayerRuleName = 'hub-views-folder-has-a-layer'

export function viewArchitectureRules(
  dependencyPath: (target: string) => string,
  packageName: string,
): UiArchitectureRule[] {
  const folders = `^hub/views/src/(?:${hubViewFolders.join('|')})/`
  return [
    {
      name: hubViewsFolderLayerRuleName,
      severity: 'error',
      comment: 'Every hub-views module folder is declared.',
      from: { path: '^hub/views/src/', pathNot: [folders] },
      to: {},
    },
    {
      name: 'hub-views-is-domain-and-router-independent',
      severity: 'error',
      comment: 'Document surfaces know no hub data, routes, router, query, or tRPC.',
      from: { path: '^hub/views/' },
      to: {
        path: [
          '^hub/(?:data|web)/',
          '^@tanstack/(?:react-query|react-router)$',
          '^@trpc/',
          dependencyPath('@tanstack/react-query'),
          dependencyPath('@tanstack/react-router'),
          dependencyPath('@trpc/client'),
          dependencyPath('@trpc/server'),
        ].join('|'),
      },
    },
    {
      name: 'hub-views-does-not-import-unresolved-hub-data',
      severity: 'error',
      comment: 'Hub views cannot import hub-data, including undeclared package subpaths.',
      from: { path: '^hub/views/' },
      to: { path: '^@bottega/hub-data(?:/|$)', couldNotResolve: true },
    },
    {
      name: 'hub-views-source-imports-use-package-exports',
      severity: 'error',
      comment: 'Code outside hub-views imports it through package exports.',
      from: {
        path: '^(?!hub/views/)',
        pathNot: ['^scripts/check-doc-editor-rich-style\\.ts$'],
      },
      to: { path: '^hub/views/src/', dependencyTypes: ['local'] },
    },
    {
      name: 'hub-views-package-imports-resolve-declared-exports',
      severity: 'error',
      comment: 'Every hub-views package import names a declared export subpath.',
      from: { path: '^(?!hub/views/)' },
      to: { path: `^${packageName}/`, couldNotResolve: true },
    },
  ]
}
