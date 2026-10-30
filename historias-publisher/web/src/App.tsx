import { LoaderCircle } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/app-shell';
import { useAuth } from './lib/auth';
import { LoginPage } from './pages/login';

const DashboardPage = lazy(() => import('./pages/dashboard'));
const CalendarPage = lazy(() => import('./pages/calendar'));
const EpisodesPage = lazy(() => import('./pages/episodes'));
const LibraryPage = lazy(() => import('./pages/library'));
const PublicationsPage = lazy(() => import('./pages/publications'));
const ChannelsPage = lazy(() => import('./pages/channels'));
const SettingsPage = lazy(() => import('./pages/settings'));
const UsagePage = lazy(() => import('./pages/usage'));

function Loading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center text-muted">
      <LoaderCircle className="size-5 animate-spin" />
    </div>
  );
}

export function App() {
  const { status } = useAuth();
  if (status === 'loading') return <Loading />;
  if (status === 'anonymous') return <LoginPage />;
  return (
    <AppShell>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/calendario" element={<CalendarPage />} />
          <Route path="/episodios" element={<EpisodesPage />} />
          <Route path="/biblioteca" element={<LibraryPage />} />
          <Route path="/publicacoes" element={<PublicationsPage />} />
          <Route path="/redes" element={<ChannelsPage />} />
          <Route path="/configuracoes" element={<SettingsPage />} />
          <Route path="/uso" element={<UsagePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
