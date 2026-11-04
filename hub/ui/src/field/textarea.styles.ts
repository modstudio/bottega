import { variant } from '../text/variant.ts'
import { controlClasses } from './control.ts'

export const textareaStyles = variant({
  slots: {
    root: 'flex w-full flex-col gap-1.5',
    control: [controlClasses, 'field-sizing-content min-h-20 w-full resize-none px-3 py-2'],
  },
  variants: {
    code: { true: { control: 'font-mono text-sm' } },
    bare: {
      true: {
        control: 'border-transparent hover:border-transparent focus-visible:border-transparent',
      },
    },
  },
})
