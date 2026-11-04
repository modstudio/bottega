import type { Meta, StoryObj } from '@storybook/react-vite'
import { FieldGroup } from './field-group'

const meta: Meta = { title: 'Primitives/FieldGroup', component: FieldGroup }
export default meta
export const Checkboxes: StoryObj<typeof meta> = {
  render: () => (
    <FieldGroup legend="Recipients" hint="Chooses which members receive the report.">
      <label htmlFor="field-group-ada">
        <input id="field-group-ada" type="checkbox" defaultChecked /> Ada
      </label>
      <label htmlFor="field-group-grace">
        <input id="field-group-grace" type="checkbox" /> Grace
      </label>
    </FieldGroup>
  ),
}
