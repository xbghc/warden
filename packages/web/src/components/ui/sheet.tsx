import { useId, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import { Button } from './button';

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const descriptionId = useId();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="wb-sheet-overlay" />
        <Dialog.Content className={`wb-sheet${wide ? ' wb-sheet-wide' : ''}`} aria-describedby={description ? descriptionId : undefined}>
          <div className="wb-sheet-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && <Dialog.Description id={descriptionId}>{description}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="关闭面板">
                <X size={18} />
              </Button>
            </Dialog.Close>
          </div>
          <div className="wb-sheet-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
