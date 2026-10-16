import type { Meta, StoryObj } from '@storybook/react-vite';
import { GitBranch, Plus, Search } from 'lucide-react';
import { Button } from './button';
import { Badge } from './badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card';
import { Checkbox } from './checkbox';
import { Input } from './input';
import { NativeSelect, NativeSelectOption } from './native-select';
import { Separator } from './separator';
import { Textarea } from './textarea';

const meta = {
  title: 'UI/Primitives',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Controls: Story = {
  render: () => (
    <Card className="w-[560px] max-w-full">
      <CardHeader>
        <CardTitle>组件与视觉规范</CardTitle>
        <CardDescription>任务编排与代码审查使用同一套 shadcn/ui 组件。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap gap-2">
          <Button>
            <Plus />
            检出分支
          </Button>
          <Button variant="outline">审查改动</Button>
          <Button variant="secondary">任务</Button>
          <Button variant="ghost" size="icon" aria-label="搜索">
            <Search />
          </Button>
          <Button disabled>检出中…</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge>
            <GitBranch />
            审查中
          </Badge>
          <Badge variant="secondary">空闲</Badge>
          <Badge variant="outline">3 个提交</Badge>
          <Badge variant="secondary" className="badge-active">
            2 条待确认
          </Badge>
        </div>
        <Separator />
        <label className="field">
          分支
          <Input placeholder="agent/review" />
        </label>
        <label className="field">
          工位
          <NativeSelect>
            <NativeSelectOption>warden-1（空闲，复用依赖）</NativeSelectOption>
            <NativeSelectOption>新建 worktree</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="field">
          评论
          <Textarea placeholder="写下给 agent 的反馈…" />
        </label>
        <label className="check">
          <Checkbox defaultChecked />
          保留当前工位
        </label>
      </CardContent>
      <CardFooter className="justify-between border-t">
        <Button variant="ghost">取消</Button>
        <Button variant="destructive">删除工位</Button>
      </CardFooter>
    </Card>
  ),
};
