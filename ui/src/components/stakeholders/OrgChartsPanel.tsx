import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Avatar from '@/components/common/Avatar';
import Button from '@/components/common/Button';
import EmptyState from '@/components/common/EmptyState';
import Input from '@/components/common/Input';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import MarkdownView from '@/components/common/MarkdownView';
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/api';
import { useAppDispatch, useAppState } from '@/store';
import { ancestorsOf, buildTree, canReportTo, collapsedForLevel, descendantsOf, managerOf, placeMember, removeMember, treeDepth, treeOrder } from '@/utils/orgChart';
import { readChartPrefs, readListCollapsed, writeChartPrefs, writeListCollapsed } from '@/utils/orgChartPrefs';
import type { OrgChart, OrgChartMember, Stakeholder } from '@/types';
import OrgChartTree, { DRAG_MIME } from './OrgChartTree';
import OrgChartViewport, { clampScale } from './OrgChartViewport';
import type { ViewportHandle } from './OrgChartViewport';
import type { NodeAction } from './OrgChartTree';
import { ChartFormModal, PersonPickerModal } from './OrgChartDialogs';
import type { ChartFormValues } from './OrgChartDialogs';

type View = 'chart' | 'outline';
const VIEW_KEY = 'gtd:org-chart-view';
/** Charts with more people than this open at two levels until the user chooses otherwise. */
const LARGE_CHART = 15;

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'outline' ? 'outline' : 'chart';
  } catch {
    return 'chart';
  }
}

interface Picker {
  mode: 'add-report' | 'change-manager';
  ref: string;
}

export default function OrgChartsPanel({ stakeholders, initialChartId }: { stakeholders: Stakeholder[]; initialChartId?: string | null }) {
  const dispatch = useAppDispatch();
  const { workspace } = useAppState();
  const workspaceKey = workspace?.path ?? 'default';
  const navigate = useNavigate();
  const [charts, setCharts] = useState<OrgChart[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingChart, setEditingChart] = useState<OrgChart | null>(null);
  const [view, setView] = useState<View>(readView);
  const [selected, setSelected] = useState<string | null>(null);
  // Explicit collapsed cards for this chart; null = no choice yet (large charts then open at two levels).
  const [collapsedPref, setCollapsedPref] = useState<Set<string> | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [peopleQuery, setPeopleQuery] = useState('');
  // Explicit choice for the "Add people" panel on this chart; undefined = none yet.
  const [panelPref, setPanelPref] = useState<boolean | undefined>(undefined);
  const [listCollapsed, setListCollapsed] = useState(readListCollapsed);
  const [fullscreen, setFullscreen] = useState(false);
  const [scale, setScale] = useState(1);
  // Temporary "Expand all" in full screen; the saved collapsed state comes back on exit.
  const [tempCollapsed, setTempCollapsed] = useState<Set<string> | null>(null);
  const viewportRef = useRef<ViewportHandle>(null);
  const fullscreenBtn = useRef<HTMLButtonElement>(null);
  const exitBtn = useRef<HTMLButtonElement>(null);
  const scaleBefore = useRef(1);
  const [search, setSearch] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const saveSeq = useRef(0);

  const notifyError = useCallback((message: string) => {
    dispatch({ type: 'ADD_NOTIFICATION', payload: { type: 'error', message } });
  }, [dispatch]);

  useEffect(() => {
    apiGet<OrgChart[]>('/api/org-charts')
      .then((list) => {
        setCharts(list);
        setActiveId((id) => id ?? (list.some((c) => c.id === initialChartId) ? initialChartId! : list[0]?.id ?? null));
      })
      .catch((err) => notifyError(err instanceof Error ? err.message : 'Could not load org charts.'))
      .finally(() => setLoading(false));
  }, [notifyError, initialChartId]);

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* storage unavailable */ }
  }, [view]);

  useEffect(() => {
    setSelected(null);
    const prefs = activeId ? readChartPrefs(workspaceKey, activeId) : {};
    setCollapsedPref(prefs.collapsed ? new Set(prefs.collapsed) : null);
    setTempCollapsed(null);
    setScale(1);
    setSearch('');
    setPanelPref(prefs.panelOpen);
  }, [activeId, workspaceKey]);

  const people = useMemo(() => new Map(stakeholders.map((s) => [s.id, s])), [stakeholders]);
  const chart = charts.find((c) => c.id === activeId) ?? null;
  const members = chart?.members ?? [];
  const memberRefs = useMemo(() => new Set(members.map((m) => m.ref)), [members]);
  const roots = useMemo(() => buildTree(members), [members]);
  const depth = useMemo(() => treeDepth(roots), [roots]);
  const savedCollapsed = useMemo(
    () => collapsedPref ?? (members.length > LARGE_CHART ? collapsedForLevel(roots, 2) : new Set<string>()),
    [collapsedPref, members.length, roots],
  );
  const collapsed = tempCollapsed ?? savedCollapsed;

  const setCollapsed = useCallback((next: Set<string>) => {
    setCollapsedPref(next);
    if (activeId) writeChartPrefs(workspaceKey, activeId, { collapsed: [...next] });
  }, [activeId, workspaceKey]);

  // While "Expand all" is active in full screen, changes stay temporary (not saved).
  const applyCollapsed = (next: Set<string>) => (tempCollapsed ? setTempCollapsed(next) : setCollapsed(next));

  // Which "Levels" button matches what is shown now (null when the user expanded cards by hand).
  const activeLevel = useMemo(() => {
    for (let level = 1; level < depth; level++) {
      const want = collapsedForLevel(roots, level);
      if (want.size === collapsed.size && [...want].every((r) => collapsed.has(r))) return level;
    }
    return [...collapsed].some((r) => members.some((m) => m.reports_to === r)) ? null : depth;
  }, [roots, depth, collapsed, members]);

  // In-chart search: name, role or id; results in top-down order.
  const matchList = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return treeOrder(roots).filter((ref) => {
      const p = people.get(ref);
      return [p?.name, p?.role, ref].some((f) => f?.toLowerCase().includes(q));
    });
  }, [search, roots, people]);
  const matchSet = useMemo(() => new Set(matchList), [matchList]);
  const currentMatch = matchList.length ? matchList[Math.min(matchIndex, matchList.length - 1)] : null;

  // The panel opens by itself only for an empty chart, and only until the user makes a choice.
  const panelOpen = panelPref ?? members.length === 0;

  const setPanelOpen = useCallback((open: boolean) => {
    setPanelPref(open);
    if (activeId) writeChartPrefs(workspaceKey, activeId, { panelOpen: open });
  }, [activeId, workspaceKey]);

  function toggleList() {
    setListCollapsed((c) => { writeListCollapsed(!c); return !c; });
  }

  const exitFullscreen = useCallback(() => {
    setFullscreen(false);
    setTempCollapsed(null);
    setScale(scaleBefore.current);
    requestAnimationFrame(() => fullscreenBtn.current?.focus());
  }, []);

  // Esc: an open dialog handles it first; then full screen closes; then the people panel.
  useEffect(() => {
    if (picker || formOpen || (!fullscreen && !panelOpen)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (fullscreen) exitFullscreen();
      else setPanelOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panelOpen, fullscreen, picker, formOpen, setPanelOpen, exitFullscreen]);

  // Entering full screen: lock page scroll, fit the chart, move focus to "Exit full screen".
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const id = requestAnimationFrame(() => { viewportRef.current?.fit(); exitBtn.current?.focus(); });
    return () => { document.body.style.overflow = previous; cancelAnimationFrame(id); };
  }, [fullscreen]);

  // Show the current match: open its collapsed managers, select it and centre it.
  useEffect(() => {
    if (!currentMatch) return;
    const hidden = ancestorsOf(members, currentMatch).filter((r) => collapsed.has(r));
    if (hidden.length) {
      const n = new Set(collapsed);
      hidden.forEach((r) => n.delete(r));
      applyCollapsed(n);
    }
    setSelected(currentMatch);
    const id = requestAnimationFrame(() => {
      document.querySelector(`.org-node[data-ref="${CSS.escape(currentMatch)}"]`)
        ?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(id);
    // Only when the match changes; revealing changes `collapsed` and must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatch]);

  function stepMatch(delta: number) {
    if (!matchList.length) return;
    setMatchIndex((i) => (Math.min(i, matchList.length - 1) + delta + matchList.length) % matchList.length);
  }

  function enterFullscreen() {
    scaleBefore.current = scale;
    setFullscreen(true);
  }

  function expandAllAndFit() {
    setTempCollapsed(new Set());
    // Fit after the expanded tree has been laid out.
    requestAnimationFrame(() => requestAnimationFrame(() => viewportRef.current?.fit()));
  }

  // Each change is saved right away; a failed save puts the previous members back.
  async function saveMembers(next: OrgChartMember[]) {
    if (!chart) return;
    const previous = chart.members;
    const seq = ++saveSeq.current;
    setCharts((list) => list.map((c) => (c.id === chart.id ? { ...c, members: next } : c)));
    try {
      const saved = await apiPut<OrgChart>(`/api/org-charts/${chart.id}`, { members: next });
      if (seq === saveSeq.current) setCharts((list) => list.map((c) => (c.id === saved.id ? saved : c)));
    } catch (err) {
      if (seq === saveSeq.current) setCharts((list) => list.map((c) => (c.id === chart.id ? { ...c, members: previous } : c)));
      notifyError(err instanceof Error ? err.message : 'Could not save the change.');
    }
  }

  function place(ref: string, manager: string | null) {
    if (!canReportTo(members, ref, manager)) {
      notifyError(`${people.get(ref)?.name ?? ref} cannot report to someone in their own team.`);
      return;
    }
    saveMembers(placeMember(members, ref, manager));
    if (manager && collapsed.has(manager)) { const n = new Set(collapsed); n.delete(manager); applyCollapsed(n); }
  }

  function handleAction(ref: string, action: NodeAction) {
    if (action === 'open') navigate(`/stakeholders/${encodeURIComponent(ref)}`);
    else if (action === 'remove') {
      saveMembers(removeMember(members, ref));
      if (selected === ref) setSelected(null);
    } else if (action === 'top-level') place(ref, null);
    else setPicker({ mode: action, ref });
  }

  async function submitChart(values: ChartFormValues) {
    const body = {
      name: values.name.trim(),
      organization: values.organization.trim(),
      description: values.description.trim(),
      notes: values.notes.trim(),
    };
    if (editingChart) {
      const saved = await apiPut<OrgChart>(`/api/org-charts/${editingChart.id}`, body);
      setCharts((list) => list.map((c) => (c.id === saved.id ? saved : c)).sort((a, b) => a.name.localeCompare(b.name)));
      return;
    }
    const org = body.organization.toLowerCase();
    const initial = values.prefill && org
      ? stakeholders.filter((s) => s.organization?.trim().toLowerCase() === org).map((s) => ({ ref: s.id }))
      : [];
    const created = await apiPost<OrgChart>('/api/org-charts', { ...body, members: initial });
    setCharts((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
    setActiveId(created.id);
  }

  async function deleteChart() {
    if (!chart) return;
    if (!window.confirm(`Delete the org chart "${chart.name}"? The stakeholders themselves are kept.`)) return;
    try {
      await apiDelete(`/api/org-charts/${chart.id}`);
      const rest = charts.filter((c) => c.id !== chart.id);
      setCharts(rest);
      setActiveId(rest[0]?.id ?? null);
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not delete the chart.');
    }
  }

  // People not in the chart yet, the chart's own organization first.
  const available = useMemo(() => {
    const org = chart?.organization?.trim().toLowerCase();
    const q = peopleQuery.trim().toLowerCase();
    return stakeholders
      .filter((s) => !memberRefs.has(s.id))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.role ?? '').toLowerCase().includes(q) || (s.organization ?? '').toLowerCase().includes(q))
      .map((s) => ({ s, sameOrg: !!org && s.organization?.trim().toLowerCase() === org }))
      .sort((a, b) => Number(b.sameOrg) - Number(a.sameOrg) || a.s.name.localeCompare(b.s.name));
  }, [stakeholders, memberRefs, chart, peopleQuery]);
  const sameOrgCount = available.filter((a) => a.sameOrg).length;

  const pickerPeople = useMemo(() => {
    if (!picker) return [];
    if (picker.mode === 'add-report') return stakeholders.filter((s) => !memberRefs.has(s.id));
    const blocked = descendantsOf(members, picker.ref);
    const current = managerOf(members, picker.ref);
    return stakeholders.filter((s) => memberRefs.has(s.id) && !blocked.has(s.id) && s.id !== current);
  }, [picker, stakeholders, memberRefs, members]);

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}><LoadingSpinner /></div>;

  const selectedName = selected ? people.get(selected)?.name ?? selected : null;
  const pickerName = picker ? people.get(picker.ref)?.name ?? picker.ref : '';

  return (
    <div className={`org-layout${listCollapsed ? ' org-layout--list-collapsed' : ''}`}>
      {/* Chart list (collapsible to a thin rail) */}
      {listCollapsed ? (
        <aside className="org-layout__list org-layout__list--rail" aria-label="Org charts">
          <button type="button" className="org-rail-btn" onClick={toggleList} aria-label="Show the chart list" title="Show the chart list">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <span className="org-rail-label">Charts · {charts.length}</span>
        </aside>
      ) : (
      <aside className="org-layout__list" aria-label="Org charts">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, padding: '12px 8px 8px 12px' }}>
          <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Charts</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Button size="sm" variant="ghost" onClick={() => { setEditingChart(null); setFormOpen(true); }}>+ New</Button>
            <button type="button" className="org-rail-btn" onClick={toggleList} aria-label="Hide the chart list" title="Hide the chart list">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M9 3L5 7l4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </span>
        </div>
        {charts.length === 0 && (
          <p style={{ padding: '0 12px 12px', margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>No charts yet.</p>
        )}
        {charts.map((c) => (
          <button key={c.id} type="button" onClick={() => setActiveId(c.id)}
            className={`org-layout__chart${c.id === activeId ? ' org-layout__chart--active' : ''}`}>
            <span style={{ display: 'block', fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--color-text)' }}>{c.name}</span>
            <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              {[c.organization, `${c.members.length} ${c.members.length === 1 ? 'person' : 'people'}`].filter(Boolean).join(' · ')}
            </span>
          </button>
        ))}
      </aside>
      )}

      {/* Editor */}
      <section className={`org-layout__editor${fullscreen ? ' org-layout__editor--fullscreen' : ''}`}
        aria-label={fullscreen && chart ? `${chart.name} (full screen)` : undefined}>
        {!chart ? (
          <EmptyState
            title="Map who reports to whom"
            description="Create an org chart for a company or organization, then arrange your stakeholders into reporting lines. Agents use it to pitch deliverables at the right level and to find the right escalation path."
            action={{ label: 'New org chart', onClick: () => { setEditingChart(null); setFormOpen(true); } }}
          />
        ) : (
          <>
            <header style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', padding: '14px 16px', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <h2 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--color-text)' }}>{chart.name}</h2>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                  {[chart.organization, chart.description].filter(Boolean).join(' · ') || 'No organization set'}
                </div>
              </div>
              <div role="tablist" aria-label="Chart view" className="org-view-toggle">
                {(['chart', 'outline'] as View[]).map((v) => (
                  <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
                    className={view === v ? 'org-view-toggle__btn org-view-toggle__btn--active' : 'org-view-toggle__btn'}>
                    {v === 'chart' ? 'Chart' : 'Outline'}
                  </button>
                ))}
              </div>
              {fullscreen ? (
                <button ref={exitBtn} type="button" className="org-tool-btn org-tool-btn--primary" onClick={exitFullscreen} title="Exit full screen (Esc)">
                  Exit full screen
                </button>
              ) : (
                <>
                  <Button size="sm" variant={panelOpen ? 'primary' : 'secondary'} aria-pressed={panelOpen} aria-controls="org-people-panel"
                    onClick={() => setPanelOpen(!panelOpen)}>
                    {panelOpen ? 'Close Add people' : 'Add people'}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => { setEditingChart(chart); setFormOpen(true); }}>Edit details</Button>
                  <Button size="sm" variant="ghost" onClick={deleteChart} style={{ color: 'var(--color-critical)' }}>Delete</Button>
                </>
              )}
            </header>

            <div className={`org-layout__body${panelOpen && !fullscreen ? '' : ' org-layout__body--no-panel'}`}>
              <div className="org-layout__canvas" onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
                {members.length === 0 ? (
                  <div
                    onDragOver={(e) => { if (dragging) e.preventDefault(); }}
                    onDrop={(e) => { e.preventDefault(); const ref = e.dataTransfer.getData(DRAG_MIME); if (ref) place(ref, null); }}
                    style={{ border: '1px dashed var(--color-border-strong)', borderRadius: 'var(--radius-lg)', padding: '40px 20px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}
                  >
                    This chart is empty. Drag people here from the <strong>Add people</strong> panel, or click <strong>Add</strong> next to a name.
                    <br />Start with the most senior person, then add their direct reports.
                  </div>
                ) : (
                  <>
                  <div className="org-toolbar">
                  {depth > 1 && (
                      <div role="group" aria-label="Levels shown" className="org-view-toggle">
                        <span className="org-toolbar__label">Levels</span>
                        {Array.from({ length: depth }, (_, i) => i + 1).map((level) => (
                          <button key={level} type="button" aria-pressed={activeLevel === level}
                            className={activeLevel === level ? 'org-view-toggle__btn org-view-toggle__btn--active' : 'org-view-toggle__btn'}
                            title={level === 1 ? 'Collapse all' : level === depth ? 'Expand all' : `Show ${level} levels`}
                            onClick={() => applyCollapsed(level === depth ? new Set() : collapsedForLevel(roots, level))}>
                            {level === depth ? 'All' : level}
                          </button>
                        ))}
                      </div>
                  )}
                    <div className="org-search" role="search">
                      <input
                        type="search"
                        value={search}
                        onChange={(e) => { setSearch(e.target.value); setMatchIndex(0); }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
                          else if (e.key === 'ArrowUp') { e.preventDefault(); stepMatch(-1); }
                          else if (e.key === 'Escape' && search) { e.preventDefault(); e.stopPropagation(); setSearch(''); }
                        }}
                        placeholder="Find in chart"
                        aria-label="Find a person in this chart"
                        className="org-search__input"
                      />
                      {search.trim() && (
                        <>
                          <span className="org-search__count" aria-live="polite">
                            {matchList.length ? `${Math.min(matchIndex, matchList.length - 1) + 1}/${matchList.length}` : 'No match'}
                          </span>
                          <button type="button" className="org-view-toggle__btn" onClick={() => stepMatch(-1)} disabled={!matchList.length} aria-label="Previous match">↑</button>
                          <button type="button" className="org-view-toggle__btn" onClick={() => stepMatch(1)} disabled={!matchList.length} aria-label="Next match">↓</button>
                        </>
                      )}
                    </div>
                    <span style={{ flex: 1 }} />
                    {view === 'chart' && (
                      <div role="group" aria-label="Zoom" className="org-view-toggle">
                        <button type="button" className="org-view-toggle__btn" onClick={() => setScale((s) => clampScale(s / 1.25))} aria-label="Zoom out" title="Zoom out (Ctrl/⌘ + scroll)">−</button>
                        <button type="button" className="org-view-toggle__btn" onClick={() => setScale(1)} title="Reset to 100%" style={{ minWidth: 48 }}>{Math.round(scale * 100)}%</button>
                        <button type="button" className="org-view-toggle__btn" onClick={() => setScale((s) => clampScale(s * 1.25))} aria-label="Zoom in" title="Zoom in (Ctrl/⌘ + scroll)">+</button>
                        <button type="button" className="org-view-toggle__btn" onClick={() => viewportRef.current?.fit()} title="Fit the visible chart">Fit</button>
                        {fullscreen && (
                          <button type="button" className="org-view-toggle__btn" onClick={expandAllAndFit} title="Expand everyone and fit; your collapsed cards come back when you leave full screen">
                            Expand all &amp; fit
                          </button>
                        )}
                      </div>
                    )}
                    {!fullscreen && (
                      <button ref={fullscreenBtn} type="button" className="org-tool-btn" onClick={enterFullscreen} title="Full screen">
                        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 4.5v-3h3M7.5 1.5h3v3M10.5 7.5v3h-3M4.5 10.5h-3v-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        Full screen
                      </button>
                    )}
                  </div>
                  {(() => {
                    const tree = (
                  <OrgChartTree
                    roots={roots}
                    people={people}
                    view={view}
                    selected={selected}
                    collapsed={collapsed}
                    dragging={dragging}
                    canDrop={(target) => (dragging ? canReportTo(members, dragging, target) : false)}
                    hasManager={(ref) => managerOf(members, ref) !== null}
                    onSelect={setSelected}
                    onToggle={(ref) => { const n = new Set(collapsed); if (n.has(ref)) n.delete(ref); else n.add(ref); applyCollapsed(n); }}
                    onDragStart={setDragging}
                    onDragEnd={() => setDragging(null)}
                    onDrop={(ref, target) => { setDragging(null); place(ref, target); }}
                    onAction={handleAction}
                    matches={matchSet}
                    currentMatch={currentMatch}
                  />
                    );
                    return view === 'chart'
                      ? <OrgChartViewport ref={viewportRef} scale={scale} onScale={setScale} fill={fullscreen}>{tree}</OrgChartViewport>
                      : tree;
                  })()}
                  </>
                )}
                {!fullscreen && (
                <p style={{ margin: '20px 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  Drag a card onto someone to make them their manager. Select a card and click <strong>+</strong> to add a direct report, or open <strong>Add people</strong> to add under it.
                  {view === 'chart' && ' Drag the background to move around; Ctrl/⌘ + scroll to zoom.'}
                </p>
                )}
                {chart.notes && !fullscreen && (
                  <div style={{ marginTop: 16, padding: '12px 14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg)' }}>
                    <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Notes</div>
                    <MarkdownView content={chart.notes} compact />
                  </div>
                )}
              </div>

              {/* People panel (hidden until opened; Esc or ✕ closes it; never in full screen) */}
              {panelOpen && !fullscreen && (
              <aside className="org-layout__people" id="org-people-panel" aria-label="People to add">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Add people
                  </span>
                  <button type="button" className="org-rail-btn" onClick={() => setPanelOpen(false)} aria-label="Close Add people" title="Close (Esc)">
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                  </button>
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 8, minHeight: 18 }}>
                  {selectedName ? (
                    <>Adding under <strong>{selectedName}</strong> · <button type="button" className="org-link-btn" onClick={() => setSelected(null)}>top level instead</button></>
                  ) : 'Adding at the top level. Select a card to add under it.'}
                </div>
                <Input value={peopleQuery} onChange={setPeopleQuery} placeholder="Search stakeholders" aria-label="Search stakeholders to add" />
                {sameOrgCount > 1 && !peopleQuery && (
                  <Button size="sm" variant="secondary" style={{ marginTop: 8, width: '100%' }}
                    onClick={() => saveMembers(available.filter((a) => a.sameOrg).reduce((acc, a) => placeMember(acc, a.s.id, selected), members))}>
                    Add all {sameOrgCount} from {chart.organization}
                  </Button>
                )}
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {available.map(({ s, sameOrg }, i) => (
                    <React.Fragment key={s.id}>
                      {i === 0 && sameOrg && <div className="org-people__group">From {chart.organization}</div>}
                      {!sameOrg && (i === 0 || available[i - 1].sameOrg) && sameOrgCount > 0 && <div className="org-people__group">Everyone else</div>}
                      <div
                        className="org-people__row"
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData(DRAG_MIME, s.id); e.dataTransfer.effectAllowed = 'copyMove'; setDragging(s.id); }}
                        onDragEnd={() => setDragging(null)}
                      >
                        <Avatar name={s.name} size="sm" initials={s.avatar_initials} />
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                          <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {s.id.startsWith('GRP-') ? 'Group' : [s.role, s.organization].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <button type="button" className="org-link-btn" onClick={() => place(s.id, selected)} aria-label={`Add ${s.name}`}>Add</button>
                      </div>
                    </React.Fragment>
                  ))}
                  {available.length === 0 && (
                    <p style={{ margin: '8px 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                      {peopleQuery ? 'Nobody matches that search.' : 'Every stakeholder is already in this chart.'}
                    </p>
                  )}
                </div>
              </aside>
              )}
            </div>
          </>
        )}
      </section>

      <ChartFormModal
        isOpen={formOpen}
        editing={editingChart}
        stakeholders={stakeholders}
        onClose={() => setFormOpen(false)}
        onSubmit={submitChart}
      />

      <PersonPickerModal
        isOpen={picker !== null}
        title={picker?.mode === 'add-report' ? `Add a direct report to ${pickerName}` : `Who does ${pickerName} report to?`}
        description={picker?.mode === 'change-manager' ? 'People in their own team are not listed, so the chart cannot loop.' : undefined}
        people={pickerPeople}
        noneLabel={picker?.mode === 'change-manager' && managerOf(members, picker.ref) ? 'Nobody (top of the chart)' : undefined}
        emptyText={picker?.mode === 'add-report' ? 'Every stakeholder is already in this chart.' : 'Nobody else in this chart can be their manager.'}
        onClose={() => setPicker(null)}
        onPick={(id) => {
          if (!picker) return;
          if (picker.mode === 'add-report' && id) place(id, picker.ref);
          else if (picker.mode === 'change-manager') place(picker.ref, id);
          setPicker(null);
        }}
      />
    </div>
  );
}
