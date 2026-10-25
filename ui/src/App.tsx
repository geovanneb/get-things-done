import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider, useAppDispatch } from './store';
import AppLayout from './components/layout/AppLayout';
import SituationView from './views/SituationView';
import BoardView from './views/BoardView';
import TaskDetailView from './views/TaskDetailView';
import StakeholdersView from './views/StakeholdersView';
import StakeholderDetailView from './views/StakeholderDetailView';
import OutputsView from './views/OutputsView';
import ContextView from './views/ContextView';
import AgentsView from './views/AgentsView';
import InsightsView from './views/InsightsView';
import ProfileView from './views/ProfileView';
import SettingsView from './views/SettingsView';
import KaizenView from './views/KaizenView';
import AgentFloorView from './views/AgentFloorView';
import { useLiveEvents } from './hooks/useLiveEvents';
import { apiGet } from './utils/api';
import { WorkspaceConfig, GitStatus } from './types';

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

function AppRoutes() {
  return (
    <>
      <AppInitializer />
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
          <Route path="agent-floor" element={<AgentFloorView />} />
          <Route path="profile" element={<ProfileView />} />
          <Route path="settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/situation" replace />} />
        </Route>
      </Routes>
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
