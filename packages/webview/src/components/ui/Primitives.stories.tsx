import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Search } from 'lucide-react';
import { Button } from './button';
import { Checkbox } from './checkbox';
import { Input } from './input';
import { NativeSelect, NativeSelectOption } from './native-select';
import { Textarea } from './textarea';

const meta = {
  title: 'UI/Primitives',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Controls: Story = {
  render: () => (
    <section className="w-[560px] max-w-full">
      <h1>Form Controls</h1>
      <div className="space-y-6">
        <div className="flex flex-wrap gap-2">
          <Button>
            <Plus />
            New Task
          </Button>
          <Button variant="outline">Review Changes</Button>
          <Button variant="secondary">Tasks</Button>
          <Button variant="ghost" size="icon" aria-label="Search">
            <Search />
          </Button>
          <Button disabled>Creating…</Button>
        </div>
        <label className="field">
          Branch
          <Input placeholder="agent/review" />
        </label>
        <label className="field">
          Git Storage
          <NativeSelect>
            <NativeSelectOption>Shared Git Storage</NativeSelectOption>
            <NativeSelectOption>Independent Clone (Compatibility)</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="field">
          Task Notes
          <Textarea placeholder="Describe the task goal and scope…" />
        </label>
        <label className="check">
          <Checkbox defaultChecked />
          Select this workspace
        </label>
      </div>
      <div className="actions">
        <Button variant="ghost">Cancel</Button>
        <Button>New Task</Button>
      </div>
    </section>
  ),
};
