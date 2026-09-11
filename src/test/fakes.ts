import { vi } from "vitest";
import type { DesktopApi } from "../platform/desktopApi";
import type { Project, ProjectDraft, TerminalSession } from "../platform/contracts";

export function projectFactory(overrides: Partial<Project> = {}): Project {
  return { id: "project-1", name: "示例项目", rootDir: "D:\\projects\\demo", description: "本地开发服务", environment: "powershell", accessPath: "http://localhost:8887", category: "开发", command: "python server.py", sortOrder: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides };
}
export function sessionFactory(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return { terminalId: "terminal-1", projectId: "project-1", shell: "powershell", workingDir: "D:\\projects\\demo", cols: 100, rows: 28, pid: 1234, ...overrides };
}
export function createFakeDesktopApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  const project = projectFactory();
  const draftToProject = (draft: ProjectDraft): Project => ({ ...project, ...draft });
  return { listProjects: vi.fn().mockResolvedValue([project]), listProjectCategories: vi.fn().mockResolvedValue([]), saveProjectCategories: vi.fn().mockImplementation(async (categories: string[]) => categories), createProject: vi.fn().mockImplementation(async (draft: ProjectDraft) => draftToProject(draft)), updateProject: vi.fn().mockImplementation(async (_id: string, draft: ProjectDraft) => draftToProject(draft)), deleteProject: vi.fn().mockResolvedValue(undefined), reorderProjects: vi.fn().mockResolvedValue([project]), openUrl: vi.fn().mockResolvedValue(undefined), selectDirectory: vi.fn().mockResolvedValue("D:\\projects\\demo"), createTerminal: vi.fn().mockResolvedValue(sessionFactory()), createStandaloneTerminal: vi.fn().mockResolvedValue(sessionFactory({ projectId: null })), startProject: vi.fn().mockResolvedValue(sessionFactory()), stopProject: vi.fn().mockResolvedValue(undefined), writeTerminal: vi.fn().mockResolvedValue(undefined), resizeTerminal: vi.fn().mockResolvedValue(undefined), closeTerminal: vi.fn().mockResolvedValue(undefined), onTerminalOutput: vi.fn().mockResolvedValue(() => undefined), onTerminalExit: vi.fn().mockResolvedValue(() => undefined), ...overrides };
}
