import {
  CalendarDays,
  Clapperboard,
  Ellipsis,
  LayoutDashboard,
  Library,
  LogOut,
  Moon,
  Plug,
  Send,
  Settings,
  Sun,
  Wallet,
} from 'lucide-react';
import * as React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent } from './ui/dialog';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, mobile: true },
  { to: '/calendario', label: 'Calendário', icon: CalendarDays, mobile: true },
  { to: '/episodios', label: 'Episódios', icon: Clapperboard, mobile: true },
  { to: '/biblioteca', label: 'Biblioteca', icon: Library, mobile: false },
  { to: '/publicacoes', label: 'Publicações', icon: Send, mobile: true },
  { to: '/redes', label: 'Redes conectadas', icon: Plug, mobile: false },
  { to: '/configuracoes', label: 'Configurações', icon: Settings, mobile: false },
];

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex size-8 items-center justify-center rounded-lg bg-accent font-display text-lg text-accent-foreground">H</div>
      <div className="leading-tight">
        <p className="font-display text-[19px]">Histórias</p>
        <p className="text-[11px] tracking-wide text-muted uppercase">Publisher</p>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { logout } = useAuth();
  const [dark, toggleTheme] = useTheme();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const location = useLocation();
  React.useEffect(() => setMoreOpen(false), [location.pathname]);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
      isActive ? 'bg-surface-2 font-medium text-foreground' : 'text-muted hover:bg-surface-2/60 hover:text-foreground',
    );

  return (
    <div className="min-h-dvh lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-surface/60 px-4 py-5 backdrop-blur lg:flex">
        <div className="px-2">
          <Brand />
        </div>
        <nav className="mt-8 flex flex-col gap-0.5">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={linkClass}>
              <n.icon className="size-[18px]" />
              {n.label}
            </NavLink>
          ))}
          <NavLink to="/uso" className={linkClass}>
            <Wallet className="size-[18px]" />
            Uso e custos
          </NavLink>
        </nav>
        <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-4">
          <p className="px-3 pb-2 text-xs text-muted">@istoriasbrasileiras</p>
          <button onClick={toggleTheme} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground">
            {dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
            {dark ? 'Tema claro' : 'Tema escuro'}
          </button>
          <button onClick={() => void logout()} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground">
            <LogOut className="size-[18px]" />
            Sair
          </button>
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background/85 px-4 backdrop-blur lg:hidden">
        <Brand />
        <button onClick={toggleTheme} className="rounded-lg p-2 text-muted hover:bg-surface-2" aria-label="Alternar tema">
          {dark ? <Sun className="size-5" /> : <Moon className="size-5" />}
        </button>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-28 sm:px-6 lg:px-10 lg:pt-10 lg:pb-12">{children}</main>

      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur lg:hidden">
        <div className="grid grid-cols-5">
          {NAV.filter((n) => n.mobile).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                cn('flex flex-col items-center gap-1 pt-2.5 pb-1 text-[10.5px]', isActive ? 'text-accent' : 'text-muted')
              }
            >
              <n.icon className="size-5" />
              {n.label.split(' ')[0]}
            </NavLink>
          ))}
          <button onClick={() => setMoreOpen(true)} className="flex flex-col items-center gap-1 pt-2.5 pb-1 text-[10.5px] text-muted">
            <Ellipsis className="size-5" />
            Mais
          </button>
        </div>
      </nav>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent title="Mais opções">
          <div className="grid gap-1">
            {[...NAV.filter((n) => !n.mobile), { to: '/uso', label: 'Uso e custos', icon: Wallet }].map((n) => (
              <NavLink key={n.to} to={n.to} className={linkClass}>
                <n.icon className="size-[18px]" />
                {n.label}
              </NavLink>
            ))}
            <button onClick={() => void logout()} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2">
              <LogOut className="size-[18px]" />
              Sair
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
