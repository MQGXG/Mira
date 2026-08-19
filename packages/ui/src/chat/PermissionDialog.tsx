import { Shield, AlertTriangle } from "lucide-react";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/button";

interface Props {
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  onAllow: () => void;
  onDeny: () => void;
  onAlways?: () => void;
}

export function PermissionDialog({ toolName, args, reason, onAllow, onDeny, onAlways }: Props) {
  return (
    <Modal open={true} onClose={onDeny} maxWidth="max-w-md">
      <div className="px-6 pt-5 pb-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "rgba(255, 184, 0, 0.1)" }}>
            <Shield className="w-5 h-5" style={{ color: "var(--warning)" }} />
          </div>
          <div>
            <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>权限请求</h2>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Agent 需要你的批准</p>
          </div>
        </div>
      </div>

      <div className="px-6 py-4 space-y-3">
        <div className="flex items-start gap-2 p-3 rounded-xl" style={{ background: "rgba(255, 184, 0, 0.05)", border: "1px solid rgba(255, 184, 0, 0.1)" }}>
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: "var(--warning)" }} />
          <div>
            <p className="text-sm font-medium" style={{ color: "var(--warning)" }}>{reason}</p>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--text-tertiary)" }}>工具</label>
          <div className="px-3 py-2 rounded-lg text-sm font-mono" style={{ background: "var(--input-bg)", border: "1px solid var(--input-border)", color: "var(--text-primary)" }}>
            {toolName}
          </div>
        </div>

        {Object.keys(args).length > 0 && (
          <div className="space-y-2">
            <label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--text-tertiary)" }}>参数</label>
            <pre className="px-3 py-2 rounded-lg text-xs font-mono max-h-32 overflow-y-auto whitespace-pre-wrap scrollbar-custom" style={{ background: "var(--input-bg)", border: "1px solid var(--input-border)", color: "var(--text-secondary)" }}>
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
        )}
      </div>

      <div className="flex gap-2 px-6 pb-5 pt-2">
        <Button
          variant="outline"
          className="flex-1"
          onClick={onDeny}
        >
          拒绝
        </Button>
        {onAlways && (
          <Button
            variant="outline"
            className="flex-1"
            style={{ borderColor: "color-mix(in srgb, var(--info) 30%, transparent)", color: "var(--info)", background: "color-mix(in srgb, var(--info) 5%, transparent)" }}
            onClick={onAlways}
          >
            始终允许
          </Button>
        )}
        <Button
          className="flex-1"
          onClick={onAllow}
        >
          允许
        </Button>
      </div>
    </Modal>
  );
}
