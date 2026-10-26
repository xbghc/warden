import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { Tooltip } from 'radix-ui';
import { Button } from './button';

export const IconButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Button> & { label: string }>(function IconButton(
  { label, children, ...props },
  ref,
) {
  return (
    <Tooltip.Provider delayDuration={400}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <Button ref={ref} type="button" variant="ghost" size="icon-xs" aria-label={label} {...props}>
            {children}
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content side="bottom" sideOffset={5} className="icon-tooltip">
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
});
