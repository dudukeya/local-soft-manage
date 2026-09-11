import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ChevronLeft, ChevronRight, Moon, Plus, Settings, Sun, TerminalSquare, X } from "lucide-react";
import type { Project, ShellKind } from "../../platform/contracts";
import { desktopApi, type DesktopApi } from "../../platform/desktopApi";
import { EmbeddedTerminal, type EmbeddedTerminalHandle } from "./EmbeddedTerminal";
import "./terminal.css";

export interface TerminalWorkspaceHandle { startProject: (projectId: string) => Promise<void>; stopProject: (projectId: string) => Promise<void>; openShell: (projectId: string, shell: ShellKind) => Promise<void>; }
export type ThemeMode = "dark" | "light";
export interface TerminalWorkspaceProps { projects: Project[]; selectedProjectId?: string | null; api?: DesktopApi; onSelectProject?: (projectId: string | null) => void; onProjectRunningChange?: (projectId: string, running: boolean) => void; theme?: ThemeMode; onToggleTheme?: () => void; onOpenSettings?: () => void; }

interface StandaloneTerminalTab { id: string; shell: ShellKind; name: string; }
type WorkspaceTab =
  | { kind: "project"; id: string; name: string; project: Project }
  | { kind: "standalone"; id: string; name: string; shell: ShellKind };

let standaloneTabSequence = 0;

/** 项目终端按需打开，独立 Shell 终端由选项卡栏的“+”按钮创建。 */
export const TerminalWorkspace = forwardRef<TerminalWorkspaceHandle, TerminalWorkspaceProps>(function TerminalWorkspace({ projects, selectedProjectId, api = desktopApi, onSelectProject, onProjectRunningChange, theme = "dark", onToggleTheme, onOpenSettings }, ref) {
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [openProjectIds, setOpenProjectIds] = useState<Set<string>>(() => new Set());
  const [standaloneTabs, setStandaloneTabs] = useState<StandaloneTerminalTab[]>([]);
  const [standaloneMenuOpen, setStandaloneMenuOpen] = useState(false);
  const handlesRef = useRef(new Map<string, EmbeddedTerminalHandle>());
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const standaloneIds = useMemo(() => new Set(standaloneTabs.map((tab) => tab.id)), [standaloneTabs]);

  useEffect(() => {
    setOpenProjectIds((current) => {
      const next = new Set([...current].filter((id) => projectById.has(id)));
      return next.size === current.size ? current : next;
    });
    setActiveTabId((current) => current && (projectById.has(current) || standaloneIds.has(current)) ? current : null);
  }, [projectById, standaloneIds]);

  const selectProject = useCallback((projectId: string) => {
    if (!projectById.has(projectId)) return;
    setOpenProjectIds((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
    setActiveTabId(projectId);
    onSelectProject?.(projectId);
  }, [onSelectProject, projectById]);

  useEffect(() => {
    if (selectedProjectId) selectProject(selectedProjectId);
  }, [selectProject, selectedProjectId]);

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest("[data-terminal-add-menu]")) setStandaloneMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setStandaloneMenuOpen(false);
    };
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const tabs = useMemo<WorkspaceTab[]>(() => [
    ...projects.filter((project) => openProjectIds.has(project.id)).map((project) => ({ kind: "project" as const, id: project.id, name: project.name, project })),
    ...standaloneTabs.map((tab) => ({ kind: "standalone" as const, ...tab })),
  ], [openProjectIds, projects, standaloneTabs]);

  const closeTab = useCallback((tabId: string) => {
    handlesRef.current.delete(tabId);
    if (projectById.has(tabId)) {
      setOpenProjectIds((current) => {
        if (!current.has(tabId)) return current;
        const next = new Set(current);
        next.delete(tabId);
        return next;
      });
    } else {
      setStandaloneTabs((current) => current.filter((tab) => tab.id !== tabId));
    }
    if (activeTabId !== tabId) return;
    const fallback = tabs.find((tab) => tab.id !== tabId);
    setActiveTabId(fallback?.id ?? null);
    onSelectProject?.(fallback?.kind === "project" ? fallback.id : null);
  }, [activeTabId, onSelectProject, projectById, tabs]);

  const selectTab = useCallback((tab: WorkspaceTab) => {
    if (tab.kind === "project") {
      selectProject(tab.id);
      return;
    }
    setActiveTabId(tab.id);
    onSelectProject?.(null);
  }, [onSelectProject, selectProject]);

  const openStandalone = useCallback((shell: ShellKind) => {
    const id = `standalone-${Date.now()}-${standaloneTabSequence += 1}`;
    const name = shell === "cmd" ? "CMD" : "PowerShell";
    setStandaloneTabs((current) => [...current, { id, shell, name }]);
    setActiveTabId(id);
    setStandaloneMenuOpen(false);
    onSelectProject?.(null);
  }, [onSelectProject]);

  const register = useCallback((tabId: string, handle: EmbeddedTerminalHandle | null) => {
    if (handle) handlesRef.current.set(tabId, handle);
    else handlesRef.current.delete(tabId);
  }, []);

  useImperativeHandle(ref, () => ({
    startProject: async (id) => { selectProject(id); await (await waitForHandle(handlesRef, id))?.startProject(); },
    stopProject: async (id) => { await (await waitForHandle(handlesRef, id))?.stopProject(); },
    openShell: async (id, shell) => { selectProject(id); await (await waitForHandle(handlesRef, id))?.openShell(shell); },
  }), [ref, selectProject]);

  const tabScrollerRef = useRef<HTMLElement>(null);
  const [tabScrollState, setTabScrollState] = useState({ hasOverflow: false, canScrollLeft: false, canScrollRight: false });
  const syncTabScroll = useCallback(() => {
    const scroller = tabScrollerRef.current;
    if (!scroller) return;
    const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    setTabScrollState({ hasOverflow: maxScroll > 1, canScrollLeft: scroller.scrollLeft > 1, canScrollRight: maxScroll - scroller.scrollLeft > 1 });
  }, []);
  useEffect(() => {
    const scroller = tabScrollerRef.current;
    if (!scroller) return;
    syncTabScroll();
    scroller.addEventListener("scroll", syncTabScroll, { passive: true });
    window.addEventListener("resize", syncTabScroll);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(syncTabScroll);
    observer?.observe(scroller);
    return () => { scroller.removeEventListener("scroll", syncTabScroll); window.removeEventListener("resize", syncTabScroll); observer?.disconnect(); };
  }, [syncTabScroll, tabs.length]);
  useEffect(() => {
    const activeTab = tabScrollerRef.current?.querySelector<HTMLElement>(".terminal-tab.is-active");
    if (activeTab && typeof activeTab.scrollIntoView === "function") activeTab.scrollIntoView({ block: "nearest", inline: "nearest" });
    syncTabScroll();
  }, [activeTabId, syncTabScroll, tabs.length]);
  const scrollTabs = (direction: -1 | 1) => {
    const scroller = tabScrollerRef.current;
    if (!scroller) return;
    const amount = Math.max(220, Math.floor(scroller.clientWidth * 0.72));
    if (typeof scroller.scrollBy === "function") scroller.scrollBy({ left: direction * amount, behavior: "smooth" });
    else scroller.scrollLeft += direction * amount;
  };

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const themeLabel = theme === "dark" ? "切换到白天模式" : "切换到黑夜模式";
  return <section className="terminal-workspace" aria-label="项目终端"><header className="terminal-workspace__header"><div><p className="section-kicker">TERMINAL WORKSPACE</p><h2><TerminalSquare size={17} />运行窗口 <small className="terminal-workspace__subtitle">每个项目拥有独立终端，切换选项卡不会中断进程。</small></h2></div><div className="terminal-workspace__header-actions"><div className="terminal-workspace__summary"><i />{activeTab?.name ?? "选择项目开始"}</div><button type="button" className="theme-toggle" onClick={onToggleTheme} aria-label={themeLabel} title={themeLabel}>{theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}</button><button type="button" className="theme-toggle" onClick={onOpenSettings} aria-label="打开设置" title="打开设置"><Settings size={15} /></button></div></header><div className="terminal-tabs-shell">{tabScrollState.hasOverflow && <button type="button" className="terminal-tabs-arrow" onClick={() => scrollTabs(-1)} disabled={!tabScrollState.canScrollLeft} aria-label="向左滚动终端选项卡"><ChevronLeft size={15} /></button>}<nav ref={tabScrollerRef} className="terminal-tabs" aria-label="终端选项卡">{tabs.map((tab) => <div className={`terminal-tab ${tab.id === activeTabId ? "is-active" : ""}`} key={tab.id}><button type="button" role="tab" aria-selected={tab.id === activeTabId} onClick={() => selectTab(tab)}><i />{tab.name}</button><button type="button" className="terminal-tab-close" onClick={() => closeTab(tab.id)} aria-label={`关闭 ${tab.name} 终端`}><X size={12} /></button></div>)}</nav><div className="terminal-add-tab-menu" data-terminal-add-menu><button className="terminal-add-tab" type="button" onClick={() => setStandaloneMenuOpen((current) => !current)} title="新建终端选项卡" aria-label="新建终端选项卡" aria-haspopup="menu" aria-expanded={standaloneMenuOpen}><Plus size={14} /></button>{standaloneMenuOpen && <div className="terminal-add-tab-options" role="menu" aria-label="新建独立终端"><button type="button" role="menuitem" onClick={() => openStandalone("cmd")}><TerminalSquare size={14} />新建 CMD</button><button type="button" role="menuitem" onClick={() => openStandalone("powershell")}><TerminalSquare size={14} />新建 PowerShell</button></div>}</div>{tabScrollState.hasOverflow && <button type="button" className="terminal-tabs-arrow" onClick={() => scrollTabs(1)} disabled={!tabScrollState.canScrollRight} aria-label="向右滚动终端选项卡"><ChevronRight size={15} /></button>}</div>{tabs.length ? <div className="terminal-tab-panes">{tabs.map((tab) => <div className={`terminal-tab-pane ${tab.id === activeTabId ? "is-active" : "is-hidden"}`} key={tab.kind === "project" ? `${tab.id}:${tab.project.updatedAt}` : tab.id}>{tab.kind === "project" ? <EmbeddedTerminal ref={(handle) => register(tab.id, handle)} project={tab.project} api={api} active={tab.id === activeTabId} theme={theme} onClose={() => closeTab(tab.id)} onRunningChange={(running) => onProjectRunningChange?.(tab.id, running)} /> : <EmbeddedTerminal ref={(handle) => register(tab.id, handle)} standaloneShell={tab.shell} standaloneName={tab.name} api={api} active={tab.id === activeTabId} theme={theme} onClose={() => closeTab(tab.id)} />}</div>)}</div> : <div className="terminal-workspace__empty"><TerminalSquare size={24} /><strong>还没有打开终端</strong><span>从左侧项目列表选择项目，或点击“+”创建独立 CMD / PowerShell。</span></div>}</section>;
});

async function waitForHandle(handles: MutableRefObject<Map<string, EmbeddedTerminalHandle>>, tabId: string): Promise<EmbeddedTerminalHandle | undefined> { for (let attempt = 0; attempt < 20; attempt += 1) { const handle = handles.current.get(tabId); if (handle) return handle; await new Promise((resolve) => window.setTimeout(resolve, 25)); } return undefined; }
