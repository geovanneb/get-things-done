import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import NavRail from './NavRail';
import Header from './Header';
import SearchOverlay from '../common/SearchOverlay';
import Toaster from '../common/Toaster';
import NewTaskModal from '../board/NewTaskModal';
import { useAppState, useAppDispatch } from '../../store';

export default function AppLayout() {
  const { isSearchOpen, newTaskModal } = useAppState();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        dispatch({ type: 'TOGGLE_SEARCH' });
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [dispatch]);

  return (
    <div style={{ display: 'flex', width: '100%', height: '100vh', overflow: 'hidden' }}>
      <NavRail />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <Header />
        <main
          id="main-content"
          style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}
        >
          <Outlet />
        </main>
      </div>
      <SearchOverlay
        isOpen={isSearchOpen}
        onClose={() => dispatch({ type: 'SET_SEARCH_OPEN', payload: false })}
      />
      <NewTaskModal
        isOpen={newTaskModal.open}
        defaultStatus={newTaskModal.defaultStatus}
        onClose={() => dispatch({ type: 'CLOSE_NEW_TASK_MODAL' })}
        onCreated={(task) => {
          dispatch({ type: 'CLOSE_NEW_TASK_MODAL' });
          // Tell any open task list to pick the new card up right away.
          dispatch({ type: 'DATA_CHANGED', payload: 'tasks' });
          navigate(`/board/task/${task.id}`);
        }}
      />
      <Toaster />
    </div>
  );
}
