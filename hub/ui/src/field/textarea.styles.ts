import { variant } from '../text/variant.ts'
import { controlClasses } from './control.ts'

export const textareaStyles = variant({
  base: [controlClasses, 'field-sizing-content min-h-20 w-full resize-none px-3 py-2'],
  variants: {
    code: { true: 'font-mono text-sm' },
    bare: { true: 'border-transparent hover:border-transparent focus-visible:border-transparent' },
  },
})
