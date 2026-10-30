import * as React from 'react';
import { api, post, setCsrfToken, setUnauthorizedHandler } from './api';

interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous';
  passwordConfigured: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<AuthState['status']>('loading');
  const [passwordConfigured, setPasswordConfigured] = React.useState(true);

  React.useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setStatus('anonymous');
    });
    api<{ authenticated: boolean; csrfToken?: string; passwordConfigured?: boolean }>('/api/auth/session')
      .then((s) => {
        if (s.authenticated && s.csrfToken) {
          setCsrfToken(s.csrfToken);
          setStatus('authenticated');
        } else {
          setPasswordConfigured(s.passwordConfigured !== false);
          setStatus('anonymous');
        }
      })
      .catch(() => setStatus('anonymous'));
  }, []);

  const value = React.useMemo<AuthState>(
    () => ({
      status,
      passwordConfigured,
      async login(password) {
        const res = await post<{ csrfToken: string }>('/api/auth/login', { password });
        setCsrfToken(res.csrfToken);
        setStatus('authenticated');
      },
      async logout() {
        try {
          await post('/api/auth/logout');
        } finally {
          setCsrfToken(null);
          setStatus('anonymous');
        }
      },
    }),
    [status, passwordConfigured],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('AuthProvider ausente');
  return ctx;
}
