import { useEffect, useState } from "react";
import { MiraLogo } from "@mira/ui/chat/MiraLogo";

export type StartupPhase = "connecting" | "ready" | "failed";

interface StartupOverlayProps {
  visible: boolean;
  phase?: StartupPhase;
  error?: string;
}

/**
 * 启动加载遮罩 — Mira logo 呼吸/流光动画 + 加载点 + 连接状态
 * 主窗口数据就绪（loadProjects 完成，隐含 Sidecar ready）后淡出并卸载
 */
export function StartupOverlay({ visible, phase = "connecting", error }: StartupOverlayProps) {
  const [mounted, setMounted] = useState(true);

  // 淡出动画（600ms）结束后卸载，避免遮罩残留拦截交互；
  // visible 重新变 true（如启动中保持 / sidecar failed 后重显）时恢复挂载
  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), 600);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!mounted) return null;

  const statusText =
    phase === "failed" ? "Core 服务连接失败" : phase === "ready" ? "连接成功，正在加载..." : "正在连接 Mira Core...";

  return (
    <div className={`startup-overlay${visible ? "" : " startup-overlay--hidden"}`}>
      <div className="startup-overlay__logo">
        <MiraLogo size={96} />
        <span className="startup-overlay__shine" />
      </div>
      <div className="startup-overlay__title">{statusText}</div>
      {/* failed 需配合 visible=true 才停留显示；visible 转 false 后 600ms 淡出卸载 */}
      {phase === "failed" && error && (
        <div className="startup-overlay__error">{error}</div>
      )}
      <div className="startup-overlay__dots">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </div>
    </div>
  );
}
