import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, FolderOpen, MoreVertical, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, Power, RefreshCw, Search, Terminal, Trash2, X } from "lucide-react";
import type { Project, ShellKind } from "../platform/contracts";
import { desktopApi, type DesktopApi } from "../platform/desktopApi";
import { ProjectForm } from "../features/projects/ProjectForm";
import { CategoryTabs } from "../features/projects/CategoryTabs";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import { TerminalWorkspace, type TerminalWorkspaceHandle, type ThemeMode } from "../features/terminal/TerminalWorkspace";
import "../styles/modal.css";

export interface AppProps { api?: DesktopApi }

/** 左侧项目管理 + 右侧独立终端选项卡。 */
export function App({ api = desktopApi }: AppProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Project | "new" | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());
  const [openMenuProjectId, setOpenMenuProjectId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(readTheme);
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState<"down" | "up">("down");
  const workspaceRef = useRef<TerminalWorkspaceHandle>(null);
  const serviceListRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    setRefreshing(true); setError(null);
    try {
      const [next, categories] = await Promise.all([api.listProjects(), api.listProjectCategories()]);
      setProjects(next);
      setCategoryOptions(categories);
      // 项目列表加载只更新数据，不自动打开第一个项目终端；终端由用户点击项目后按需创建。
      setSelectedProjectId((current) => current && next.some((p) => p.id === current) ? current : null);
    }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setLoading(false); setRefreshing(false); }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { try { window.localStorage.setItem("soft-manage-theme", theme); } catch { /* 本地存储不可用时仍保持当前会话主题。 */ } }, [theme]);
  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest("[data-project-menu]")) setOpenMenuProjectId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuProjectId(null);
    };
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  const categoryItems = useMemo(() => {
    const used = new Set(projects.map((project) => project.category.trim()).filter(Boolean));
    const items = ["all", ...categoryOptions.filter((category) => used.has(category))];
    if (projects.some((project) => !project.category.trim())) items.push("uncategorized");
    return items.map((id) => ({ id, label: id === "all" ? "全部" : id === "uncategorized" ? "未分类" : id, count: id === "all" ? projects.length : id === "uncategorized" ? projects.filter((project) => !project.category.trim()).length : projects.filter((project) => project.category.trim() === id).length }));
  }, [categoryOptions, projects]);
  useEffect(() => { if (activeCategory !== "all" && !categoryItems.some((item) => item.id === activeCategory)) setActiveCategory("all"); }, [activeCategory, categoryItems]);
  const filteredProjects = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return projects.filter((project) => {
      const category = project.category.trim();
      const categoryMatch = activeCategory === "all" || (activeCategory === "uncategorized" ? !category : category === activeCategory);
      const searchMatch = !needle || [project.name, project.rootDir, project.description, project.command, project.accessPath, category].join(" ").toLocaleLowerCase().includes(needle);
      return categoryMatch && searchMatch;
    });
  }, [activeCategory, projects, search]);
  const saveProject = useCallback((project: Project) => { setEditor(null); setOpenMenuProjectId(null); setSelectedProjectId(project.id); void reload(); }, [reload]);
  const deleteProject = useCallback(async (project: Project) => { if (!window.confirm(`确定删除项目“${project.name}”吗？这只会删除 Local Soft Manage 中的配置。`)) return; setOpenMenuProjectId(null); try { await api.deleteProject(project.id); await reload(); } catch (reason) { setError(errorMessage(reason)); } }, [api, reload]);
  const run = useCallback(async (project: Project) => { setOpenMenuProjectId(null); setSelectedProjectId(project.id); try { await workspaceRef.current?.startProject(project.id); setRunningIds((current) => new Set(current).add(project.id)); } catch (reason) { setError(errorMessage(reason)); } }, []);
  const stop = useCallback(async (project: Project) => { setOpenMenuProjectId(null); setSelectedProjectId(project.id); try { await workspaceRef.current?.stopProject(project.id); setRunningIds((current) => { const next = new Set(current); next.delete(project.id); return next; }); } catch (reason) { setError(errorMessage(reason)); } }, []);
  const openShell = useCallback(async (project: Project, shell: ShellKind) => { setOpenMenuProjectId(null); setSelectedProjectId(project.id); try { await workspaceRef.current?.openShell(project.id, shell); } catch (reason) { setError(errorMessage(reason)); } }, []);
  const openBrowser = useCallback(async (project: Project) => { setOpenMenuProjectId(null); setSelectedProjectId(project.id); if (!project.accessPath.trim()) return; try { await api.openUrl(project.accessPath); } catch (reason) { setError(errorMessage(reason)); } }, [api]);
  const moveProject = useCallback(async (project: Project, direction: -1 | 1) => {
    setOpenMenuProjectId(null);
    const visibleIndex = filteredProjects.findIndex((item) => item.id === project.id);
    const neighbor = filteredProjects[visibleIndex + direction];
    const index = projects.findIndex((item) => item.id === project.id);
    const target = neighbor ? projects.findIndex((item) => item.id === neighbor.id) : -1;
    if (visibleIndex < 0 || !neighbor || index < 0 || target < 0) return;
    const next = [...projects];
    [next[index], next[target]] = [next[target], next[index]];
    setProjects(next);
    try { const saved = await api.reorderProjects(next.map((item) => item.id)); setProjects(saved); }
    catch (reason) { setError(errorMessage(reason)); void reload(); }
  }, [api, filteredProjects, projects, reload]);
  const updateRunning = useCallback((projectId: string, running: boolean) => { setRunningIds((current) => { const next = new Set(current); if (running) next.add(projectId); else next.delete(projectId); return next; }); }, []);
  const saveCategories = useCallback(async (next: string[]) => {
    const saved = await api.saveProjectCategories(next);
    setCategoryOptions(saved);
  }, [api]);

  return <main className={`manager-shell ${sidebarCollapsed ? "is-sidebar-collapsed" : ""} ${theme === "light" ? "is-light" : ""}`}>
    <div className="manager-left-column">
      <aside className={`manager-sidebar ${sidebarCollapsed ? "is-collapsed" : ""}`}>
        <div className="sidebar-brand">
          <span className="brand-mark"><Terminal size={17} /></span>
          {!sidebarCollapsed && <span className="sidebar-brand-copy"><strong>Local Soft Manage</strong><small>本地项目控制台</small></span>}
          <button type="button" className="sidebar-collapse-toggle" onClick={() => { setSidebarCollapsed((current) => !current); setOpenMenuProjectId(null); }} title={sidebarCollapsed ? "展开左侧栏" : "收起左侧栏"} aria-label={sidebarCollapsed ? "展开左侧栏" : "收起左侧栏"} aria-expanded={!sidebarCollapsed}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
        </div>
        {!sidebarCollapsed && <>
        <div className="sidebar-search-row">
          <label className="sidebar-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目…" aria-label="搜索项目" />{search && <button type="button" onClick={() => setSearch("")} aria-label="清除搜索"><X size={13} /></button>}</label>
          <button type="button" className="icon-button" onClick={() => setEditor("new")} title="新建项目" aria-label="新建项目"><Plus size={17} /></button>
          <button type="button" className="icon-button" onClick={() => void reload()} disabled={refreshing} title="刷新项目" aria-label="刷新项目"><RefreshCw size={15} className={refreshing ? "spin" : undefined} /></button>
        </div>
        <div className="sidebar-section-title"><span>项目列表</span><span>{projects.length} 个</span></div>
        <CategoryTabs items={categoryItems} activeId={activeCategory} onSelect={setActiveCategory} />
        <div ref={serviceListRef} className="service-list">
          {loading ? <p className="sidebar-empty">正在加载项目…</p> : filteredProjects.length === 0 ? <div className="sidebar-empty"><FolderOpen size={18} /><span>{projects.length ? "没有匹配项目" : "还没有项目"}</span><button type="button" onClick={() => setEditor("new")}>新建一个项目</button></div> : filteredProjects.map((project) => <div className={`project-row ${project.id === selectedProjectId ? "is-selected" : ""} ${project.id === openMenuProjectId ? "is-menu-open" : ""}`} key={project.id}>
            <button type="button" className="project-row-main" onClick={() => { setSelectedProjectId(project.id); setOpenMenuProjectId(null); }}>
              <i className={runningIds.has(project.id) ? "is-running" : ""} />
              <span><strong>{project.name}</strong><small>{project.environment === "cmd" ? "CMD" : "PowerShell"} · {project.rootDir}</small>{project.category.trim() && categoryOptions.includes(project.category.trim()) && <em className="project-category-badge">{project.category.trim()}</em>}</span>
              {runningIds.has(project.id) && <em>运行中</em>}
            </button>
            <div className="project-row-menu" data-project-menu>
              <button type="button" className="project-row-order-button" onClick={() => void moveProject(project, -1)} disabled={filteredProjects.findIndex((item) => item.id === project.id) <= 0} aria-label={`${project.name} 上移项目`} title="上移项目"><ArrowUp size={14} /></button>
              <button type="button" className="project-row-order-button" onClick={() => void moveProject(project, 1)} disabled={filteredProjects.findIndex((item) => item.id === project.id) < 0 || filteredProjects.findIndex((item) => item.id === project.id) === filteredProjects.length - 1} aria-label={`${project.name} 下移项目`} title="下移项目"><ArrowDown size={14} /></button>
              <button type="button" className="project-row-menu-trigger" aria-label={`${project.name} 项目操作`} aria-haspopup="menu" aria-expanded={project.id === openMenuProjectId} onClick={(event) => {
                setSelectedProjectId(project.id);
                if (openMenuProjectId === project.id) {
                  setOpenMenuProjectId(null);
                  return;
                }
                const trigger = event.currentTarget.getBoundingClientRect();
                const viewport = serviceListRef.current?.getBoundingClientRect();
                const menuHeight = 300;
                const spaceBelow = (viewport?.bottom ?? window.innerHeight) - trigger.bottom;
                const spaceAbove = trigger.top - (viewport?.top ?? 0);
                setMenuPlacement(spaceBelow >= menuHeight || spaceBelow >= spaceAbove ? "down" : "up");
                setOpenMenuProjectId(project.id);
              }}><MoreVertical size={17} /></button>
              {project.id === openMenuProjectId && <div className={`project-row-menu-list ${menuPlacement === "up" ? "is-open-upward" : ""}`} role="menu" aria-label={`${project.name} 操作`}>
                <button type="button" role="menuitem" onClick={() => void run(project)}><Play size={14} />启动项目</button>
                <button type="button" role="menuitem" onClick={() => void openShell(project, "cmd")}><Terminal size={14} />打开 CMD</button>
                <button type="button" role="menuitem" onClick={() => void openShell(project, "powershell")}><Terminal size={14} />打开 PowerShell</button>
                <button type="button" role="menuitem" onClick={() => void stop(project)}><Power size={14} />停止项目</button>
                <div className="project-row-menu-divider" role="separator" />
                <button type="button" role="menuitem" onClick={() => void openBrowser(project)} disabled={!project.accessPath.trim()} title={project.accessPath.trim() ? project.accessPath : "请先在项目配置中填写访问路径"}><ExternalLink size={14} />浏览器访问</button>
                <div className="project-row-menu-divider" role="separator" />
                <button type="button" role="menuitem" onClick={() => { setOpenMenuProjectId(null); setEditor(project); }}><Pencil size={14} />配置项目</button>
                <button type="button" role="menuitem" className="is-danger" onClick={() => void deleteProject(project)}><Trash2 size={14} />删除项目</button>
              </div>}
            </div>
          </div>)}
        </div>
        {error && <div className="app-error" role="alert">{error}</div>}
        <div className="sidebar-footer"><span>© duduke</span></div>
        </>}
      </aside>
    </div>
    <TerminalWorkspace ref={workspaceRef} projects={projects} selectedProjectId={selectedProjectId} api={api} onSelectProject={setSelectedProjectId} onProjectRunningChange={updateRunning} theme={theme} onToggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")} onOpenSettings={() => setSettingsOpen(true)} />
    {editor && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null); }}><div className="editor-surface" role="dialog" aria-modal="true" aria-labelledby="project-editor-title"><div className="editor-header"><div><p className="section-kicker">PROJECT CONFIGURATION</p><h2 id="project-editor-title">{editor === "new" ? "新建项目" : `编辑 ${editor.name}`}</h2></div><button type="button" className="icon-button" onClick={() => setEditor(null)} aria-label="关闭"><X size={16} /></button></div><ProjectForm project={editor === "new" ? undefined : editor} api={api} categories={categoryOptions} onSaved={saveProject} onCancel={() => setEditor(null)} /></div></div>}
    <SettingsDialog open={settingsOpen} categories={categoryOptions} onSave={saveCategories} onClose={() => setSettingsOpen(false)} />
  </main>;
}

function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason || "操作失败"); }

function readTheme(): ThemeMode {
  try { return window.localStorage.getItem("soft-manage-theme") === "light" ? "light" : "dark"; }
  catch { return "dark"; }
}
