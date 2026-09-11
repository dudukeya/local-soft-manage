import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 React 根节点");

interface ErrorBoundaryState { error: Error | null; }

/** 捕获渲染异常并提供可操作的错误页面，避免 WebView 只显示空白。 */
class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Local Soft Manage 界面渲染失败", error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, color: "#1d2633", background: "#f4f6f9", fontFamily: "system-ui, sans-serif" }}>
      <section role="alert" style={{ width: "min(680px, 100%)", padding: 24, border: "1px solid #d94a62", borderRadius: 12, background: "#fff", boxShadow: "0 12px 30px #00000014" }}>
        <h1 style={{ margin: "0 0 10px", fontSize: 20 }}>界面加载失败</h1>
        <p style={{ margin: "0 0 12px", color: "#687384" }}>保存或刷新后发生了未处理的界面错误。请把下面的错误信息提供给开发者。</p>
        <pre style={{ margin: "0 0 16px", padding: 12, overflow: "auto", whiteSpace: "pre-wrap", color: "#8b1e35", background: "#fff3f5", borderRadius: 8, fontSize: 12 }}>{this.state.error.stack || this.state.error.message}</pre>
        <button type="button" onClick={() => window.location.reload()} style={{ border: "1px solid #356fd6", borderRadius: 7, padding: "8px 14px", color: "#fff", background: "#356fd6", cursor: "pointer" }}>重新加载应用</button>
      </section>
    </main>;
  }
}

createRoot(root).render(<StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>);
