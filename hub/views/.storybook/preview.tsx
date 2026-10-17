import '@bottega/hub-ui/styles/tokens.css'
import '@bottega/hub-ui/styles/theme.css'
import type { Preview } from '@storybook/react-vite'

const preview: Preview = {
  parameters: {
    a11y: { test: 'error' },
    backgrounds: { disable: true },
  },
  globalTypes: {
    theme: {
      description: 'Design-system color theme',
      defaultValue: 'light',
      toolbar: {
        icon: 'paintbrush',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
      },
    },
  },
  decorators: [
    (story, context) => {
      document.documentElement.classList.toggle('dark', context.globals.theme === 'dark')
      return story()
    },
  ],
}

export default preview
