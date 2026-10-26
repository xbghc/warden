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
      <h1>表单控件</h1>
      <div className="space-y-6">
        <div className="flex flex-wrap gap-2">
          <Button>
            <Plus />
            创建工作区
          </Button>
          <Button variant="outline">审查改动</Button>
          <Button variant="secondary">任务</Button>
          <Button variant="ghost" size="icon" aria-label="搜索">
            <Search />
          </Button>
          <Button disabled>创建中…</Button>
        </div>
        <label className="field">
          分支
          <Input placeholder="agent/review" />
        </label>
        <label className="field">
          Git 存储方式
          <NativeSelect>
            <NativeSelectOption>共享 Git 存储</NativeSelectOption>
            <NativeSelectOption>独立 clone（兼容模式）</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="field">
          任务说明
          <Textarea placeholder="描述任务目标与范围…" />
        </label>
        <label className="check">
          <Checkbox defaultChecked />
          选择此工作区
        </label>
      </div>
      <div className="actions">
        <Button variant="ghost">取消</Button>
        <Button>创建工作区</Button>
      </div>
    </section>
  ),
};
