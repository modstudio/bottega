import { variant } from '../text/variant.ts'

export const errorStateStyles = variant({
  slots: {
    root: 'flex flex-col items-center gap-1 px-6 py-10 text-center text-status-text',
    title: 'font-medium',
    message: 'max-w-md whitespace-pre-wrap text-sm',
    action: 'mt-3',
  },
})
