import { extendTailwindMerge } from 'tailwind-merge'
import { createTV, type TWMergeConfig } from 'tailwind-variants'

export const themeKeys = {
  color: [
    'transparent',
    'current',
    'surface-page',
    'surface-raised',
    'surface-sunken',
    'surface-overlay',
    'scrim',
    'selection',
    'text-primary',
    'text-secondary',
    'text-muted',
    'text-inverse',
    'text-disabled',
    'icon-primary',
    'icon-muted',
    'link',
    'link-hover',
    'border-subtle',
    'border-default',
    'border-strong',
    'control-rest',
    'control-hover',
    'control-pressed',
    'control-selected',
    'control-disabled',
    'accent-fill',
    'accent-fill-hover',
    'accent-on-fill',
    'accent-surface',
    'accent-border',
    'accent-text',
    'focus',
    'status-fill',
    'status-fill-hover',
    'status-on-fill',
    'status-text',
    'status-surface',
    'status-border',
    'chart-1',
    'chart-2',
    'chart-3',
    'chart-4',
    'chart-grid',
    'chart-axis',
    'project',
  ],
  shadow: ['raised', 'overlay'],
  font: ['sans', 'serif', 'mono'],
  text: ['xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl'],
  radius: [],
  ease: ['standard', 'exit'],
  spacing: ['control-sm', 'control-md', 'control-lg', 'row', 'topbar', 'rail', 'rail-open'],
} as const

const mergeConfig = {
  extend: {
    theme: themeKeys,
  },
} satisfies TWMergeConfig

export const mergeThemeClasses = extendTailwindMerge(mergeConfig)
export const variant = createTV({ twMergeConfig: mergeConfig })
