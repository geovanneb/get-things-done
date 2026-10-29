import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider, useAppDispatch } from './store';
import AppLayout from './components/layout/AppLayout';
import { useLiveEvents } from './hooks/useLiveEvents';
import { apiGet } from './utils/api';
import { WorkspaceConfig, GitStatus } from './types';
import type { SetupStatus } from './utils/setup';

const SituationView = lazy(() => import('./views/SituationView'));
const BoardView = lazy(() => import('./views/BoardView'));
const TaskDetailView = lazy(() => import('./views/TaskDetailView'));
const StakeholdersView = lazy(() => import('./views/StakeholdersView'));
const StakeholderDetailView = lazy(() => import('./views/StakeholderDetailView'));
const OutputsView = lazy(() => import('./views/OutputsView'));
const ContextView = lazy(() => import('./views/ContextView'));
const AgentsView = lazy(() => import('./views/AgentsView'));
const InsightsView = lazy(() => import('./views/InsightsView'));
const ProfileView = lazy(() => import('./views/ProfileView'));
const SettingsView = lazy(() => import('./views/SettingsView'));
const KaizenView = lazy(() => import('./views/KaizenView'));
const RoutinesView = lazy(() => import('./views/RoutinesView'));
const AgentFloorView = lazy(() => import('./views/AgentFloorView'));
const SetupView = lazy(() => import('./views/SetupView'));

function AppInitializer() {
  const dispatch = useAppDispatch();

  // Live workspace updates (file watcher -> SSE -> refetch)
  useLiveEvents();

  useEffect(() => {
    // Fetch workspace config
    apiGet<WorkspaceConfig>('/api/workspace')
      .then((ws) => dispatch({ type: 'SET_WORKSPACE', payload: ws }))
      .catch(() => {});

    // Fetch git status
    apiGet<GitStatus>('/api/workspace/git/status')
      .then((git) => dispatch({ type: 'SET_GIT_STATUS', payload: git }))
      .catch(() => {});

    // Fetch validation count
    apiGet<{ errors: number; warnings: number }>('/api/workspace/validation/count')
      .then((count) => dispatch({ type: 'SET_VALIDATION_COUNT', payload: count }))
      .catch(() => {});
  }, [dispatch]);

  return null;
}

const loading = <div role="status" style={{ padding: 24 }}>Loading…</div>;

function AppRoutes() {
  // Without an open workspace the dashboard has nothing to show: first-run setup takes its place at any address.
  // If the check fails (an older server, a network error), the dashboard loads as before.
  const [setup, setSetup] = useState<SetupStatus | 'ready' | null>(null);
  useEffect(() => {
    apiGet<SetupStatus>('/api/setup')
      .then((status) => setSetup(status.configured ? 'ready' : status))
      .catch(() => setSetup('ready'));
  }, []);

  if (setup === null) return loading;
  if (setup !== 'ready') {
    return (
      <Suspense fallback={loading}>
        <SetupView status={setup} />
      </Suspense>
    );
  }

  return (
    <>
      <AppInitializer />
      <Suspense fallback={loading}>
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<Navigate to="/situation" replace />} />
          <Route path="situation" element={<SituationView />} />
          <Route path="board" element={<BoardView />}>
            <Route path="task/:id" element={<TaskDetailView />} />
          </Route>
          <Route path="stakeholders" element={<StakeholdersView />} />
          <Route path="stakeholders/:id" element={<StakeholderDetailView />} />
          <Route path="outputs" element={<OutputsView />} />
          <Route path="context" element={<ContextView />} />
          <Route path="context/updates" element={<ContextView />} />
          <Route path="context/updates/:id" element={<ContextView />} />
          <Route path="agents" element={<AgentsView />} />
          <Route path="insights" element={<InsightsView />} />
          <Route path="kaizen" element={<KaizenView />} />
          <Route path="routines" element={<RoutinesView />} />
          <Route path="agent-floor" element={<AgentFloorView />} />
          <Route path="profile" element={<ProfileView />} />
          <Route path="settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/situation" replace />} />
        </Route>
      </Routes>
      </Suspense>
    </>
  );
}

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProvider>
  );
}
