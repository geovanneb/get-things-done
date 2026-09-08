import React, { createContext, useContext, useReducer, ReactNode } from 'react';
import { WorkspaceConfig, GitStatus, Task } from '../types';

interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  timestamp: number;
}

interface AppState {
  workspace: WorkspaceConfig | null;
  gitStatus: GitStatus | null;
  validationCount: { errors: number; warnings: number };
  isSearchOpen: boolean;
  activeView: string;
  notifications: Notification[];
  newTaskModal: { open: boolean; defaultStatus: Task['status'] };
}

type Action =
  | { type: 'SET_WORKSPACE'; payload: WorkspaceConfig | null }
  | { type: 'SET_GIT_STATUS'; payload: GitStatus | null }
  | { type: 'SET_VALIDATION_COUNT'; payload: { errors: number; warnings: number } }
  | { type: 'TOGGLE_SEARCH' }
  | { type: 'SET_SEARCH_OPEN'; payload: boolean }
  | { type: 'SET_ACTIVE_VIEW'; payload: string }
  | { type: 'ADD_NOTIFICATION'; payload: Omit<Notification, 'id' | 'timestamp'> }
  | { type: 'REMOVE_NOTIFICATION'; payload: string }
  | { type: 'OPEN_NEW_TASK_MODAL'; payload?: Task['status'] }
  | { type: 'CLOSE_NEW_TASK_MODAL' };

const initialState: AppState = {
  workspace: null,
  gitStatus: null,
  validationCount: { errors: 0, warnings: 0 },
  isSearchOpen: false,
  activeView: 'situation',
  notifications: [],
  newTaskModal: { open: false, defaultStatus: 'backlog' },
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_WORKSPACE':
      return { ...state, workspace: action.payload };
    case 'SET_GIT_STATUS':
      return { ...state, gitStatus: action.payload };
    case 'SET_VALIDATION_COUNT':
      return { ...state, validationCount: action.payload };
    case 'TOGGLE_SEARCH':
      return { ...state, isSearchOpen: !state.isSearchOpen };
    case 'SET_SEARCH_OPEN':
      return { ...state, isSearchOpen: action.payload };
    case 'SET_ACTIVE_VIEW':
      return { ...state, activeView: action.payload };
    case 'ADD_NOTIFICATION':
      return {
        ...state,
        notifications: [
          ...state.notifications,
          {
            ...action.payload,
            id: Math.random().toString(36).slice(2),
            timestamp: Date.now(),
          },
        ],
      };
    case 'REMOVE_NOTIFICATION':
      return {
        ...state,
        notifications: state.notifications.filter((n) => n.id !== action.payload),
      };
    case 'OPEN_NEW_TASK_MODAL':
      return { ...state, newTaskModal: { open: true, defaultStatus: action.payload ?? 'backlog' } };
    case 'CLOSE_NEW_TASK_MODAL':
      return { ...state, newTaskModal: { ...state.newTaskModal, open: false } };
    default:
      return state;
  }
}

const StateContext = createContext<AppState>(initialState);
const DispatchContext = createContext<React.Dispatch<Action>>(() => {});

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        {children}
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState() {
  return useContext(StateContext);
}

export function useAppDispatch() {
  return useContext(DispatchContext);
}
