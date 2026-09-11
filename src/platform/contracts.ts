export type ShellKind = "powershell" | "cmd";

export interface ProjectDraft {
  name: string;
  rootDir: string;
  description: string;
  environment: ShellKind;
  accessPath: string;
  category: string;
  command: string;
}

export interface Project extends ProjectDraft {
  id: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalSession {
  terminalId: string;
  projectId: string | null;
  shell: ShellKind;
  workingDir: string;
  cols: number;
  rows: number;
  pid: number | null;
}

export interface CreateTerminalRequest {
  projectId: string;
  shell?: ShellKind;
  cols?: number;
  rows?: number;
}

export interface StandaloneTerminalRequest {
  shell: ShellKind;
  cols?: number;
  rows?: number;
}

export interface TerminalOutput {
  terminalId: string;
  data: string;
}

export interface TerminalExit {
  terminalId: string;
  exitCode: number | null;
  signal: string | null;
}

export interface ValidationResult {
  ok: boolean;
  errors: Record<string, string>;
}
