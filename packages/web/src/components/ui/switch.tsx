import type { ComponentProps } from 'react';
import { Switch as Primitive } from 'radix-ui';
import { cn } from '../../lib/utils';

export function Switch({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root className={cn('wb-switch', className)} {...props}>
      <Primitive.Thumb className="wb-switch-thumb" />
    </Primitive.Root>
  );
}
