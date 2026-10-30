import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

type Tone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  description?: string;
}

const ToastContext = React.createContext<(t: Omit<ToastItem, 'id'>) => void>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const push = React.useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list.slice(-3), { ...t, id }]);
    window.setTimeout(() => setItems((list) => list.filter((i) => i.id !== id)), t.tone === 'error' ? 8000 : 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-3 sm:bottom-6 sm:items-end sm:px-6" aria-live="polite">
        {items.map((t) => {
          const Icon = t.tone === 'success' ? CircleCheck : t.tone === 'error' ? CircleAlert : Info;
          return (
            <div
              key={t.id}
              className={cn(
                'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-surface px-4 py-3 shadow-xl animate-in',
                t.tone === 'error' ? 'border-danger/40' : 'border-border',
              )}
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', t.tone === 'success' ? 'text-success' : t.tone === 'error' ? 'text-danger' : 'text-info')} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t.title}</p>
                {t.description && <p className="mt-0.5 text-xs break-words text-muted">{t.description}</p>}
              </div>
              <button className="text-muted hover:text-foreground" onClick={() => setItems((l) => l.filter((i) => i.id !== t.id))} aria-label="Fechar aviso">
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = React.useContext(ToastContext);
  return React.useMemo(
    () => ({
      success: (title: string, description?: string) => push({ tone: 'success', title, description }),
      error: (title: string, description?: string) => push({ tone: 'error', title, description }),
      info: (title: string, description?: string) => push({ tone: 'info', title, description }),
    }),
    [push],
  );
}
