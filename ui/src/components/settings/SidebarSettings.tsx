import { useState } from 'react';
import Button from '@/components/common/Button';
import { useAppDispatch, useAppState } from '@/store';
import { useSaveSidebar } from '@/hooks/useSidebar';
import { DEFAULT_SIDEBAR, isDefaultSidebar, navGroups } from '@/components/layout/navGroups';

/** Settings entry for the sidebar order. It opens the same editor as the sidebar's own "Customize" link. */
export default function SidebarSettings() {
  const { sidebar, agenticVisualMode, sidebarEditing } = useAppState();
  const dispatch = useAppDispatch();
  const save = useSaveSidebar();
  const [confirming, setConfirming] = useState(false);
  const isDefault = isDefaultSidebar(navGroups({ agentFloor: agenticVisualMode }), sidebar);

  if (confirming) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text)' }}>
          Reset the sidebar to the default order and show every item?
        </span>
        <Button size="sm" variant="primary" onClick={() => { save(DEFAULT_SIDEBAR); setConfirming(false); }}>Reset</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <Button size="sm" variant="secondary" disabled={sidebarEditing} onClick={() => dispatch({ type: 'SET_SIDEBAR_EDITING', payload: true })}>
        Customize…
      </Button>
      <Button size="sm" variant="ghost" disabled={isDefault} onClick={() => setConfirming(true)}>
        Reset to default
      </Button>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
        {isDefault ? 'Default order.' : 'Your own order.'} Saved in this workspace.
      </span>
    </div>
  );
}
