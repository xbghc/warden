import type { Meta, StoryObj } from '@storybook/react-vite';
import { Check, Info, MessageSquarePlus, MoreHorizontal, PanelRight, RefreshCw, X } from 'lucide-react';
import { Button } from './button';
import { Checkbox } from './checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu';
import { IconButton } from './icon-button';
import { Input } from './input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from './select';
import { StatusBadge } from './status-badge';
import { Textarea } from './textarea';

const meta = {
  title: 'UI/Primitives',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The shared primitives as the Task, Rebase and Task Chat webviews use them. */
export const Controls: Story = {
  render: () => (
    <section className="w-[560px] max-w-full space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button>Configure ACP</Button>
        <Button variant="secondary" size="sm">
          I Have Signed In — Reconnect
        </Button>
        <Button disabled>Rebase Selected</Button>
      </div>
      <div className="actions">
        <IconButton label="Save Notes" variant="default">
          <Check aria-hidden="true" />
        </IconButton>
        <IconButton label="Discard Changes">
          <X aria-hidden="true" />
        </IconButton>
        <IconButton label="Check Again">
          <RefreshCw aria-hidden="true" />
        </IconButton>
        <IconButton label="Move Chat to Side Bar" size="icon-sm">
          <PanelRight aria-hidden="true" />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="More Chat Actions" size="icon-sm">
              <MoreHorizontal aria-hidden="true" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem>
              <Info aria-hidden="true" />
              Info: Show
            </DropdownMenuItem>
            <DropdownMenuItem>
              <MessageSquarePlus aria-hidden="true" />
              New Session
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="field">
        <Input aria-label="Title" placeholder="Task title" />
      </div>
      <div className="field">
        <Textarea aria-label="Notes" placeholder="Additional notes (optional)" rows={4} />
      </div>
      <label className="selection-toggle">
        <Checkbox aria-label="Select All" defaultChecked />
        Select all
      </label>
      <Select defaultValue="default">
        <SelectTrigger className="acp-picker" aria-label="Model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="acp-picker-menu" aria-label="Model">
          <SelectGroup>
            <SelectLabel>Model</SelectLabel>
            <SelectItem value="default" description="The agent's recommended model">
              Default
            </SelectItem>
            <SelectItem value="fast">Fast</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <div className="flex flex-wrap gap-2">
        <StatusBadge status="connected">Connected</StatusBadge>
        <StatusBadge status="current">Up to Date</StatusBadge>
        <StatusBadge status="waiting_permission">Permission Required</StatusBadge>
        <StatusBadge status="conflict">Conflicts Expected</StatusBadge>
        <StatusBadge status="unknown">Unknown</StatusBadge>
      </div>
    </section>
  ),
};
