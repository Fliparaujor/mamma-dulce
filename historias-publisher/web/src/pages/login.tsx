import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Notice } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export function LoginPage() {
  const { login, passwordConfigured } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-5">
      <div className="w-full max-w-sm animate-in">
        <div className="mb-10">
          <div className="mb-6 flex size-11 items-center justify-center rounded-xl bg-accent font-display text-2xl text-accent-foreground">H</div>
          <h1 className="font-display text-[44px] leading-none">Histórias Publisher</h1>
          <p className="mt-3 text-sm text-muted">Planejamento e publicação dos episódios do @istoriasbrasileiras.</p>
        </div>
        {!passwordConfigured && (
          <Notice tone="warning" className="mb-4">
            A senha do administrador ainda não foi configurada no servidor. Gere o hash com <code>npm run hash-password</code> e salve como segredo{' '}
            <code>ADMIN_PASSWORD_HASH</code>.
          </Notice>
        )}
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Senha</Label>
            <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button type="submit" size="lg" loading={loading}>
            <KeyRound />
            Entrar
          </Button>
        </form>
      </div>
    </div>
  );
}
