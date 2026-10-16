import { variant } from '../text/variant.ts'

const base =
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-colors duration-(--duration-fast) disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0'
const looks = {
  primary: 'bg-accent-fill text-accent-on-fill hover:bg-accent-fill-hover',
  secondary:
    'border border-border-default bg-surface-page text-text-primary hover:bg-control-hover active:bg-control-pressed',
  ghost: 'text-text-primary hover:bg-control-hover active:bg-control-pressed',
  danger: 'bg-status-fill text-status-on-fill hover:bg-status-fill-hover',
}

export const buttonStyles = variant({
  base,
  variants: {
    variant: looks,
    size: {
      sm: 'h-control-sm gap-1.5 px-2.5 text-sm [&_svg]:size-3.5',
      md: 'h-control-md gap-2 px-3.5 text-base [&_svg]:size-4',
      lg: 'h-control-lg gap-2 px-5 text-md [&_svg]:size-4',
    },
  },
  defaultVariants: { variant: 'secondary', size: 'md' },
})

export const iconButtonStyles = variant({
  base,
  variants: {
    variant: looks,
    size: {
      sm: 'size-(--control-h-sm) [&_svg]:size-3.5',
      md: 'size-(--control-h-md) [&_svg]:size-4',
      lg: 'size-(--control-h-lg) [&_svg]:size-5',
    },
  },
  defaultVariants: { variant: 'ghost', size: 'md' },
})

export const textButtonStyles = variant({
  base: 'cursor-pointer underline decoration-border-strong underline-offset-2 hover:decoration-current disabled:pointer-events-none disabled:opacity-50',
})
