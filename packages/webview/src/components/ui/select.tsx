import { forwardRef } from 'react';
import type * as React from 'react';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import { cn } from '../../lib/utils';

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;
const SelectGroup = SelectPrimitive.Group;

const SelectTrigger = forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>>(function SelectTrigger(
  { className, children, ...props },
  ref,
) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      data-slot="select-trigger"
      className={cn('inline-flex min-w-0 items-center gap-1 rounded-sm outline-none disabled:opacity-50', className)}
      {...props}
    >
      <span data-slot="select-value" className="min-w-0 truncate">
        {children}
      </span>
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon data-slot="select-icon" className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

function SelectContent({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position="popper"
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className={cn(
          'z-50 max-h-[min(360px,var(--radix-select-content-available-height))] w-64 max-w-[calc(100vw-24px)] overflow-hidden rounded-md border border-border bg-background text-foreground shadow-md',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn('px-2 py-1 text-xs text-muted-foreground', className)} {...props} />;
}

function SelectItem({ className, children, description, ...props }: React.ComponentProps<typeof SelectPrimitive.Item> & { description?: string }) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex cursor-default items-start rounded-sm py-1.5 pr-2 pl-7 text-xs outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemIndicator className="absolute top-2 left-2">
        <CheckIcon className="size-3" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        {description && <span className="mt-0.5 block text-muted-foreground">{description}</span>}
      </span>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectLabel, SelectItem };
