import { variant } from '../text/variant.ts'

export const infoTipStyles = variant({
  slots: {
    trigger:
      'inline-flex size-5 shrink-0 cursor-pointer items-center justify-center self-center rounded-full text-text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-focus',
    prose: 'max-w-80 space-y-2 font-normal font-sans text-sm text-text normal-case tracking-normal',
  },
})
