import { useEffect, useState } from "react";
import { MiraLogo } from "@mira/ui/chat/MiraLogo";

interface StartupOverlayProps {
  visible: boolean;
}

/**
 * 启动加载遮罩 — Mira logo 呼吸/流光动画 + 加载点
 * 主窗口数据就绪（loadProjects 完成，隐含 Sidecar ready）后淡出并卸载
 */
export function StartupOverlay({ visible }: StartupOverlayProps) {
  const [mounted, setMounted] = useState(true);

  // 淡出动画（600ms）结束后卸载，避免遮罩残留拦截交互
  useEffect(() => {
    if (visible) return;
    const timer = setTimeout(() => setMounted(false), 600);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!mounted) return null;

  return (
    <div className={`startup-overlay${visible ? "" : " startup-overlay--hidden"}`}>
      <div className="startup-overlay__logo">
        <MiraLogo size={96} />
        <span className="startup-overlay__shine" />
      </div>
      <div className="startup-overlay__title">正在启动 Mira...</div>
      <div className="startup-overlay__dots">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </div>
    </div>
  );
}
