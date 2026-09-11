import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Minus, Play, Plus, Power, RefreshCw, TerminalSquare, X } from "lucide-react";
import type { Project, ShellKind, TerminalExit, TerminalOutput, TerminalSession } from "../../platform/contracts";
import type { ThemeMode } from "./TerminalWorkspace";
import { desktopApi, type DesktopApi } from "../../platform/desktopApi";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

export interface EmbeddedTerminalHandle {
  startProject: () => Promise<void>;
  stopProject: () => Promise<void>;
  openShell: (shell: ShellKind) => Promise<void>;
}
export interface EmbeddedTerminalProps { project?: Project; standaloneShell?: ShellKind; standaloneName?: string; api?: DesktopApi; active?: boolean; theme?: ThemeMode; onClose?: () => void; onRunningChange?: (running: boolean) => void; }
type TerminalState = "idle" | "connecting" | "ready" | "running" | "stopping" | "stopped" | "error";

/** 一个项目对应一个 PTY。切换选项卡只隐藏 DOM，不会关闭会话。 */
export const EmbeddedTerminal = forwardRef<EmbeddedTerminalHandle, EmbeddedTerminalProps>(function EmbeddedTerminal({ project, standaloneShell, standaloneName, api = desktopApi, active = true, theme = "dark", onClose, onRunningChange }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const projectRef = useRef(project);
  const activeRef = useRef(active);
  const operationRef = useRef(false);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [state, setState] = useState<TerminalState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [fontSize, setFontSize] = useState(13);
  const stopPromptTimerRef = useRef<number | null>(null);
  const stopPromptRequestedRef = useRef(false);
  const outputTailRef = useRef("");
  const runningChangeRef = useRef(onRunningChange);
  projectRef.current = project;
  activeRef.current = active;
  runningChangeRef.current = onRunningChange;

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = xtermTheme(theme);
  }, [theme]);
  const clearStopPromptWatch = useCallback(() => {
    stopPromptRequestedRef.current = false;
    outputTailRef.current = "";
    if (stopPromptTimerRef.current !== null) {
      window.clearTimeout(stopPromptTimerRef.current);
      stopPromptTimerRef.current = null;
    }
  }, []);

  const armStopPromptWatch = useCallback(() => {
    clearStopPromptWatch();
    stopPromptRequestedRef.current = true;
    stopPromptTimerRef.current = window.setTimeout(() => { clearStopPromptWatch(); setState("stopped"); }, 3_000);
  }, [clearStopPromptWatch]);

  const fit = useCallback(() => {
    if (!activeRef.current || !terminalRef.current || !fitRef.current) return;
    try {
      fitRef.current.fit();
      const current = sessionRef.current;
      if (current) void api.resizeTerminal(current.terminalId, terminalRef.current.cols, terminalRef.current.rows).catch(() => undefined);
    } catch { /* 隐藏选项卡下次激活时再适配。 */ }
  }, [api]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = fontSize;
    fit();
  }, [fit, fontSize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 13, lineHeight: 1.2, scrollback: 8_000, theme: xtermTheme(theme) });
    const addon = new FitAddon(); terminal.loadAddon(addon); terminal.open(container);
    terminalRef.current = terminal; fitRef.current = addon;
    const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
    // 视口层位于屏幕层上方时，只有滚动条区域需要阻止 xterm 根节点接管事件。
    // 不调用 preventDefault，保留浏览器原生滚动条的点击、拖动和分页滚动行为。
    const allowScrollbarInteraction = (event: MouseEvent) => {
      if (!viewport || !isScrollbarHit(viewport, event)) return;
      event.stopPropagation();
    };
    viewport?.addEventListener("mousedown", allowScrollbarInteraction, true);
    viewport?.addEventListener("pointerdown", allowScrollbarInteraction, true);
    viewport?.addEventListener("click", allowScrollbarInteraction, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit); observer?.observe(container);
    const frame = window.requestAnimationFrame(fit);
    const sendInput = (data: string) => { const current = sessionRef.current; if (current && !operationRef.current) void api.writeTerminal(current.terminalId, data).catch((reason) => { setError(errorMessage(reason)); setState("error"); }); };
    const input = terminal.onData(sendInput);
    // DSR 等终端控制响应通过 onBinary 回写，保证全量交互 Shell 正常工作。
    const binaryInput = terminal.onBinary(sendInput);
    const resize = terminal.onResize(({ cols, rows }) => { const current = sessionRef.current; if (current) void api.resizeTerminal(current.terminalId, cols, rows).catch(() => undefined); });
    return () => { window.cancelAnimationFrame(frame); observer?.disconnect(); viewport?.removeEventListener("mousedown", allowScrollbarInteraction, true); viewport?.removeEventListener("pointerdown", allowScrollbarInteraction, true); viewport?.removeEventListener("click", allowScrollbarInteraction, true); input.dispose(); binaryInput.dispose(); resize.dispose(); terminal.dispose(); terminalRef.current = null; fitRef.current = null; };
  }, [api, fit]);

  useEffect(() => {
    let disposed = false; let unlistenOutput: (() => void) | undefined; let unlistenExit: (() => void) | undefined;
    void (async () => {
      try {
        unlistenOutput = await api.onTerminalOutput((output: TerminalOutput) => {
          if (disposed || output.terminalId !== sessionRef.current?.terminalId) return;
          terminalRef.current?.write(output.data);
          const cleanOutput = stripAnsi(`${outputTailRef.current}${output.data}`);
          outputTailRef.current = cleanOutput.slice(-256);
          if (!stopPromptRequestedRef.current) return;
          const reply = batchPromptReply(cleanOutput);
          if (!reply) return;
          if (reply === "y\r\n") {
            clearStopPromptWatch();
            void api.writeTerminal(output.terminalId, reply).then(() => setState("stopped")).catch((reason) => { setError(errorMessage(reason)); setState("error"); });
            return;
          }
          void api.writeTerminal(output.terminalId, reply).catch((reason) => { setError(errorMessage(reason)); setState("error"); });
        });
        unlistenExit = await api.onTerminalExit((exit: TerminalExit) => {
          if (!disposed && exit.terminalId === sessionRef.current?.terminalId) {
            setExitCode(exit.exitCode); setState("stopped"); clearStopPromptWatch(); runningChangeRef.current?.(false);
            terminalRef.current?.writeln(`\r\n\x1b[90m[终端已退出${exit.exitCode == null ? "" : `，退出码 ${exit.exitCode}`} ]\x1b[0m`);
            sessionRef.current = null; setSession(null);
          }
        });
      } catch (reason) { if (!disposed) { setError(errorMessage(reason)); setState("error"); } }
    })();
    return () => { disposed = true; unlistenOutput?.(); unlistenExit?.(); };
  }, [api, clearStopPromptWatch]);

  const attachSession = useCallback((next: TerminalSession) => {
    sessionRef.current = next; setSession(next); setExitCode(null); setState("ready");
    terminalRef.current?.writeln(`\x1b[90mLocal Soft Manage · ${next.shell === "cmd" ? "CMD" : "PowerShell"} · ${next.workingDir}\x1b[0m\r`); fit();
  }, [fit]);

  const createSession = useCallback(async (shell: ShellKind = projectRef.current?.environment ?? standaloneShell ?? "powershell", force = false) => {
    if (operationRef.current || !terminalRef.current) return;
    const existing = sessionRef.current; if (existing?.shell === shell && !force) return;
    operationRef.current = true; setState("connecting"); setError(null); clearStopPromptWatch();
    try {
      if (existing) { runningChangeRef.current?.(false); sessionRef.current = null; setSession(null); await api.closeTerminal(existing.terminalId); }
      const terminal = terminalRef.current;
      if (force) terminal.clear();
      const next = projectRef.current
        ? await api.createTerminal({ projectId: projectRef.current.id, shell, cols: terminal.cols || 100, rows: terminal.rows || 28 })
        : await api.createStandaloneTerminal({ shell, cols: terminal.cols || 100, rows: terminal.rows || 28 });
      attachSession(next);
    } catch (reason) { setError(errorMessage(reason)); setState("error"); }
    finally { operationRef.current = false; }
  }, [api, attachSession, clearStopPromptWatch, standaloneShell]);

  const startProject = useCallback(async () => {
    if (operationRef.current || !projectRef.current?.command.trim()) return;
    operationRef.current = true; setState("connecting"); setError(null); setExitCode(null); clearStopPromptWatch();
    if (!projectRef.current) return;
    try { attachSession(await api.startProject(projectRef.current.id)); setState("running"); runningChangeRef.current?.(true); }
    catch (reason) { setError(errorMessage(reason)); setState("error"); }
    finally { operationRef.current = false; }
  }, [api, attachSession, clearStopPromptWatch]);
  const stopProject = useCallback(async () => {
    if (operationRef.current || !sessionRef.current) return;
    operationRef.current = true; setError(null); setState("stopping"); armStopPromptWatch();
    if (!projectRef.current) return;
    const waitsForBatchPrompt = commandLooksLikeBatch(projectRef.current.command);
    try { await api.stopProject(projectRef.current.id); runningChangeRef.current?.(false); if (!waitsForBatchPrompt) { clearStopPromptWatch(); setState("stopped"); } }
    catch (reason) { clearStopPromptWatch(); setError(errorMessage(reason)); setState("error"); }
    finally { operationRef.current = false; }
  }, [api, armStopPromptWatch, clearStopPromptWatch]);
  const openShell = useCallback((shell: ShellKind) => createSession(shell), [createSession]);
  const rebuildTerminal = useCallback(() => createSession(sessionRef.current?.shell ?? projectRef.current?.environment ?? standaloneShell ?? "powershell", true), [createSession, standaloneShell]);
  useImperativeHandle(ref, () => ({ startProject, stopProject, openShell }), [openShell, startProject, stopProject]);
  useEffect(() => {
    if (!active) return;
    // 选项卡恢复可见时重新计算尺寸；隐藏面板期间 ResizeObserver 不会得到可靠尺寸。
    fit();
    void createSession();
  }, [active, createSession, fit]);
  useEffect(() => () => { clearStopPromptWatch(); const current = sessionRef.current; sessionRef.current = null; if (current) void api.closeTerminal(current.terminalId).catch(() => undefined); }, [api, clearStopPromptWatch]);

  const stateLabel: Record<TerminalState, string> = { idle: "未连接", connecting: "连接中", ready: "终端就绪", running: "命令运行中", stopping: "停止中", stopped: "已停止", error: "发生错误" };
  const terminalName = project?.name ?? standaloneName ?? "独立终端";
  const displayedShell = session?.shell ?? project?.environment ?? standaloneShell ?? "powershell";
  return <section className="embedded-terminal" aria-label={`${terminalName} 终端`}>
    <header className="embedded-terminal__toolbar"><div className="embedded-terminal__title"><TerminalSquare size={15} /><strong>{terminalName}</strong><span>{displayedShell === "cmd" ? "CMD" : "PowerShell"}</span><i className={state === "running" || state === "ready" ? "is-live" : ""} /><em>{stateLabel[state]}</em></div><div className="embedded-terminal__header-actions"><div className="terminal-font-controls" role="group" aria-label="终端字体大小"><button type="button" onClick={() => setFontSize((current) => Math.max(10, current - 1))} disabled={fontSize <= 10} aria-label="缩小终端字体" title="缩小终端字体"><Minus size={13} /></button><span aria-live="polite">{fontSize}px</span><button type="button" onClick={() => setFontSize((current) => Math.min(24, current + 1))} disabled={fontSize >= 24} aria-label="放大终端字体" title="放大终端字体"><Plus size={13} /></button></div><button type="button" onClick={() => void rebuildTerminal()} disabled={state === "connecting" || state === "stopping"}><RefreshCw size={13} />重建终端</button>{project && <button type="button" className="terminal-run-button" onClick={() => void startProject()} disabled={!project.command.trim() || state === "connecting" || state === "stopping" || state === "running"}><Play size={13} />启动项目</button>}<button type="button" onClick={() => void stopProject()} disabled={state !== "running"}><Power size={13} />停止</button><button type="button" onClick={onClose} aria-label="关闭终端"><X size={15} /></button></div></header>
    <div ref={containerRef} className="embedded-terminal__screen" />
    <footer className="embedded-terminal__footer"><span>{session ? `工作目录：${session.workingDir}` : "正在等待终端连接…"}</span>{session?.pid != null && <span>PID：{session.pid}</span>}{error && <span className="terminal-error">{error}</span>}{exitCode != null && <span>退出码：{exitCode}</span>}<span className="terminal-hint" title="复制：先用鼠标选中文字，再按 Ctrl+Insert；粘贴：Ctrl+V 或 Shift+Insert；中断：Ctrl+C">快捷键：复制 Ctrl+Insert · 粘贴 Ctrl+V / Shift+Insert · 中断 Ctrl+C</span></footer>
  </section>;
});

function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason || "终端操作失败"); }

function isScrollbarHit(viewport: HTMLElement, event: MouseEvent): boolean {
  const rect = viewport.getBoundingClientRect();
  const nativeScrollbarWidth = viewport.offsetWidth - viewport.clientWidth;
  const scrollbarWidth = Math.max(nativeScrollbarWidth, 12);
  return event.clientX >= rect.right - scrollbarWidth;
}

function xtermTheme(theme: ThemeMode) {
  return theme === "light"
    ? { background: "#f7f9fc", foreground: "#1d2939", cursor: "#315895", selectionBackground: "#c9d9f2" }
    : { background: "#08111f", foreground: "#dbeafe", cursor: "#93c5fd", selectionBackground: "#24436b" };
}

function stripAnsi(value: string): string { return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""); }

function commandLooksLikeBatch(command: string): boolean {
  return command.toLowerCase().split(/\s+/).some((token) => {
    const normalized = token.replace(/["'`()\[\]{};,]+$/g, "");
    return normalized.endsWith(".bat") || normalized.endsWith(".cmd");
  });
}

function batchPromptReply(value: string): string | null {
  if (/(?:终止|是否终止).*批处理操作.*[（(]\s*y\s*\/\s*n\s*[）)]\s*\?/i.test(value) || /terminate\s+batch\s+job\s*[（(]\s*y\s*\/\s*n\s*[）)]\s*\?/i.test(value)) return "y\r\n";
  if (/请按任意键继续|press any key to continue/i.test(value)) return "\r\n";
  return null;
}
