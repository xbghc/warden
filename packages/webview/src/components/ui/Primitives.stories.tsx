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
            创建工作区
          </Button>
          <Button variant="outline">审查改动</Button>
          <Button variant="secondary">任务</Button>
          <Button variant="ghost" size="icon" aria-label="搜索">
            <Search />
          </Button>
          <Button disabled>创建中…</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge>
            <GitBranch />
            审查中
          </Badge>
          <Badge variant="secondary">空闲</Badge>
          <Badge variant="outline">3 个提交</Badge>
          <Badge variant="secondary">2 个文件</Badge>
        </div>
        <Separator />
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
      </CardContent>
      <CardFooter className="justify-between border-t">
        <Button variant="ghost">取消</Button>
        <Button>创建工作区</Button>
      </CardFooter>
    </Card>
  ),
};
