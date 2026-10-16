import type { Meta, StoryObj } from '@storybook/react-vite'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table'

const meta: Meta = { title: 'Patterns/Table', component: Table }
export default meta
export const Rows: StoryObj<typeof meta> = {
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Task</TableHead>
          <TableHead numeric>Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow interactive>
          <TableCell>DEV-1378</TableCell>
          <TableCell numeric>$4.20</TableCell>
        </TableRow>
        <TableRow selected>
          <TableCell muted>DEV-1377</TableCell>
          <TableCell numeric nowrap>
            $3.10
          </TableCell>
        </TableRow>
        <TableRow nested>
          <TableCell>Child run</TableCell>
          <TableCell numeric>$0.80</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
}
