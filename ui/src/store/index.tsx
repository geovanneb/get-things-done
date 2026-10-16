import React, { createContext, useContext, useReducer, useEffect, ReactNode } from 'react';
import { WorkspaceConfig, GitStatus, Task } from '../types';
import {
  ThemeMode,
  AccentName,
  TextSize,
  applyAppearance,
  readThemeMode,
  readAccent,
  readTextSize,
  storeThemeMode,
  storeAccent,
  storeTextSize,
  watchSystemTheme,
} from '../utils/theme';

interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  timestamp: number;
}

/** Which slice of workspace data a change touched. */
export type DataScope =
  | 'tasks'
  | 'stakeholders'
  | 'outputs'
  | 'context'
  | 'kaizen'
  | 'profile'
  | 'other';

export type DataVersions = Record<DataScope, number>;

const initialVersions: DataVersions = {
  tasks: 0,
  stakeholders: 0,
  outputs: 0,
  context: 0,
  kaizen: 0,
  profile: 0,
  other: 0,
};

/** localStorage key for the experimental Agent Floor visualisation. */
export const AGENTIC_MODE_KEY = 'gtd:agentic-visual-mode';

function readAgenticMode(): boolean {
  try {
    return localStorage.getItem(AGENTIC_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

interface AppState {
  workspace: WorkspaceConfig | null;
  gitStatus: GitStatus | null;
  validationCount: { errors: number; warnings: number };
  isSearchOpen: boolean;
  activeView: string;
  notifications: Notification[];
  newTaskModal: { open: boolean; defaultStatus: Task['status'] };
  /** Bumped whenever a slice of data changes, so views can refetch. */
  dataVersions: DataVersions;
  /** Experimental: show the Agent Floor visualisation in the nav. */
  agenticVisualMode: boolean;
  /** Appearance preferences, persisted per browser. */
  theme: ThemeMode;
  accent: AccentName;
  textSize: TextSize;
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
  | { type: 'CLOSE_NEW_TASK_MODAL' }
  | { type: 'DATA_CHANGED'; payload: DataScope }
  | { type: 'SET_AGENTIC_VISUAL_MODE'; payload: boolean }
  | { type: 'SET_THEME'; payload: ThemeMode }
  | { type: 'SET_ACCENT'; payload: AccentName }
  | { type: 'SET_TEXT_SIZE'; payload: TextSize };

const initialState: AppState = {
  workspace: null,
  gitStatus: null,
  validationCount: { errors: 0, warnings: 0 },
  isSearchOpen: false,
  activeView: 'situation',
  notifications: [],
  newTaskModal: { open: false, defaultStatus: 'backlog' },
  dataVersions: initialVersions,
  agenticVisualMode: readAgenticMode(),
  theme: readThemeMode(),
  accent: readAccent(),
  textSize: readTextSize(),
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
    case 'SET_AGENTIC_VISUAL_MODE':
      try {
        localStorage.setItem(AGENTIC_MODE_KEY, action.payload ? '1' : '0');
      } catch {
        // Preference is still applied for this session.
      }
      return { ...state, agenticVisualMode: action.payload };
    case 'SET_THEME':
      return { ...state, theme: action.payload };
    case 'SET_ACCENT':
      return { ...state, accent: action.payload };
    case 'SET_TEXT_SIZE':
      return { ...state, textSize: action.payload };
    case 'DATA_CHANGED':
      return {
        ...state,
        dataVersions: {
          ...state.dataVersions,
          [action.payload]: state.dataVersions[action.payload] + 1,
        },
      };
    default:
      return state;
  }
}

const StateContext = createContext<AppState>(initialState);
const DispatchContext = createContext<React.Dispatch<Action>>(() => {});

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { theme, accent, textSize } = state;

  useEffect(() => {
    applyAppearance(theme, accent, textSize);
    storeThemeMode(theme);
    storeAccent(accent);
    storeTextSize(textSize);
  }, [theme, accent, textSize]);

  useEffect(() => {
    if (theme !== 'system') return;
    return watchSystemTheme(() => applyAppearance(theme, accent, textSize));
  }, [theme, accent, textSize]);

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

/** Counter that changes whenever `scope` data changes. Use it as a useApi dep. */
export function useDataVersion(scope: DataScope): number {
  return useContext(StateContext).dataVersions[scope];
}
