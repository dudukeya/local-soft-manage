import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  CreateTerminalRequest,
  Project,
  ProjectDraft,
  ShellKind,
  StandaloneTerminalRequest,
  TerminalExit,
  TerminalOutput,
  TerminalSession,
} from "./contracts";

type InvokeArgs = Record<string, unknown> | undefined;
type InvokeFunction = <T>(command: string, args?: InvokeArgs) => Promise<T>;
type ListenFunction = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<UnlistenFn>;
type SelectDirectoryFunction = (options: { directory: true; multiple: false; title: string }) => Promise<string | string[] | null>;

export interface DesktopApi {
  listProjects(): Promise<Project[]>;
  listProjectCategories(): Promise<string[]>;
  saveProjectCategories(categories: string[]): Promise<string[]>;
  createProject(draft: ProjectDraft): Promise<Project>;
  updateProject(projectId: string, draft: ProjectDraft): Promise<Project>;
  deleteProject(projectId: string): Promise<void>;
  reorderProjects(projectIds: string[]): Promise<Project[]>;
  openUrl(url: string): Promise<void>;
  selectDirectory(): Promise<string | null>;
  createTerminal(request: CreateTerminalRequest): Promise<TerminalSession>;
  createStandaloneTerminal(request: StandaloneTerminalRequest): Promise<TerminalSession>;
  startProject(projectId: string): Promise<TerminalSession>;
  stopProject(projectId: string): Promise<void>;
  writeTerminal(terminalId: string, data: string): Promise<void>;
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
  onTerminalOutput(listener: (output: TerminalOutput) => void): Promise<UnlistenFn>;
  onTerminalExit(listener: (exit: TerminalExit) => void): Promise<UnlistenFn>;
}

export interface DesktopApiDependencies {
  invoke: InvokeFunction;
  listen: ListenFunction;
  selectDirectory: SelectDirectoryFunction;
}

const defaultDependencies: DesktopApiDependencies = {
  invoke: tauriInvoke as InvokeFunction,
  listen: tauriListen as ListenFunction,
  selectDirectory: openDialog as SelectDirectoryFunction,
};

export function createDesktopApi(dependencies: DesktopApiDependencies = defaultDependencies): DesktopApi {
  const { invoke, listen, selectDirectory } = dependencies;
  return {
    listProjects: () => invoke<Project[]>("list_projects"),
    listProjectCategories: () => invoke<string[]>("list_project_categories"),
    saveProjectCategories: (categories) => invoke<string[]>("save_project_categories", { categories }),
    createProject: (draft) => invoke<Project>("create_project", { draft }),
    updateProject: (projectId, draft) => invoke<Project>("update_project", { projectId, draft }),
    deleteProject: (projectId) => invoke<void>("delete_project", { projectId }),
    reorderProjects: (projectIds) => invoke<Project[]>("reorder_projects", { projectIds }),
    openUrl: (url) => invoke<void>("open_url", { url }),
    async selectDirectory() {
      const selected = await selectDirectory({ directory: true, multiple: false, title: "选择项目目录" });
      return typeof selected === "string" ? selected : null;
    },
    createTerminal: (request) => invoke<TerminalSession>("create_terminal", { request }),
    createStandaloneTerminal: (request) => invoke<TerminalSession>("create_standalone_terminal", { request }),
    startProject: (projectId) => invoke<TerminalSession>("start_project", { projectId }),
    stopProject: (projectId) => invoke<void>("stop_project", { projectId }),
    writeTerminal: (terminalId, data) => invoke<void>("write_terminal", { terminalId, data }),
    resizeTerminal: (terminalId, cols, rows) => invoke<void>("resize_terminal", { terminalId, cols, rows }),
    closeTerminal: (terminalId) => invoke<void>("close_terminal", { terminalId }),
    onTerminalOutput: (listener) => listen<TerminalOutput>("terminal://output", ({ payload }) => listener(payload)),
    onTerminalExit: (listener) => listen<TerminalExit>("terminal://exit", ({ payload }) => listener(payload)),
  };
}

export const desktopApi = createDesktopApi();

export type { ShellKind };
