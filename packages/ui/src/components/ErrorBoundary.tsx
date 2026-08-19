"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 出错时的降级 UI（不传则显示默认错误提示） */
  fallback?: ReactNode;
  /** 出错回调（便于日志） */
  onError?: (error: Error, errorInfo: unknown) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * 错误边界 — 防止单个组件渲染异常导致整个 React 树卸载（白屏）。
 * 包裹聊天消息区等动态渲染区域，出错时显示降级 UI 而非白屏。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: unknown) {
    this.props.onError?.(error, errorInfo);
    console.error("[ErrorBoundary]", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          className="mx-auto my-4 max-w-[560px] rounded-xl border px-4 py-3 text-sm"
          style={{ borderColor: "var(--border)", background: "var(--bg-elevated)", color: "var(--fg-secondary)" }}
        >
          <div className="mb-1 font-medium" style={{ color: "var(--error)" }}>⚠️ 渲染出现异常</div>
          <div className="mb-3 break-words text-xs" style={{ color: "var(--fg-tertiary)" }}>
            {this.state.error?.message || "未知错误"}
          </div>
          <button
            onClick={this.handleReset}
            className="rounded-md px-3 py-1.5 text-xs transition-colors"
            style={{ background: "var(--bg-secondary)", color: "var(--fg)" }}
          >
            重试渲染
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
