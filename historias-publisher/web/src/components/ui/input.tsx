import * as React from 'react';
import { cn } from '@/lib/utils';

const field =
  'w-full rounded-lg border border-border-strong bg-surface px-3 text-sm text-foreground placeholder:text-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, onClick, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(field, 'h-10', className)}
    onClick={(e) => {
      onClick?.(e);
      // Clicar em qualquer parte do campo de data abre o calendário, não só no ícone.
      if (props.type === 'date') {
        try {
          e.currentTarget.showPicker();
        } catch {
          // Navegador sem showPicker: segue digitando no campo.
        }
      }
    }}
    {...props}
  />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(field, 'min-h-24 py-2 leading-relaxed', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(field, 'h-10 appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-8', className)} {...props}>
    {children}
  </select>
));
Select.displayName = 'Select';

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-[13px] font-medium text-foreground', className)} {...props} />;
}

export function Field({ label, hint, children, className }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
