import { variant } from '../text/variant.ts'

export const switchStyles = variant({
  base: 'relative h-5 w-9 shrink-0 cursor-pointer rounded-full bg-border-strong transition-colors duration-(--duration-base) before:absolute before:top-0.5 before:left-0.5 before:size-4 before:rounded-full before:bg-surface-page before:shadow-raised before:transition-transform before:duration-(--duration-base) checked:bg-accent-fill checked:before:translate-x-4 disabled:cursor-not-allowed disabled:opacity-50',
})
