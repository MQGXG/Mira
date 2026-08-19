import { useState, useEffect } from "react";
import { Folder, Plus } from "lucide-react";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { DialogService } from "../services/dialog.service";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, workspacePath: string) => void;
}

export function NewProjectDialog({ open, onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setWorkspacePath("");
      setError("");
      // 预填默认工作目录（设置 > 系统默认 Documents/Mira）
      (async () => {
        try {
          const s = JSON.parse(localStorage.getItem("settings") || "{}") as { defaultWorkspace?: string };
          let p = s.defaultWorkspace || "";
          if (!p) {
            try { p = (await window.electronAPI.ts.getDefaultWorkspace()) || ""; } catch { /* ignore */ }
          }
          if (p) setWorkspacePath(p);
        } catch { /* ignore */ }
      })();
    }
  }, [open]);

  const handleChooseDir = async () => {
    const dirs = await DialogService.openDirectory();
    if (dirs && dirs.length > 0) {
      setWorkspacePath(dirs[0]);
      if (!name) {
        const parts = dirs[0].split(/[/\\]/);
        setName(parts[parts.length - 1] || "");
      }
      setError("");
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    const ws = workspacePath.trim();
    if (!ws) {
      setError("请选择项目文件夹");
      return;
    }
    onCreate(n, ws);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="打开项目">
      <div className="p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: "var(--text-secondary)" }}>
              项目文件夹
            </label>
            <Button
              type="button"
              variant="outline"
              onClick={handleChooseDir}
              className="w-full justify-start font-normal text-secondary"
            >
              <Folder className="w-4 h-4 shrink-0" />
              <span className="truncate">{workspacePath || "选择项目文件夹"}</span>
            </Button>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: "var(--text-secondary)" }}>
              项目名称
            </label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="项目名称"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="text-secondary"
            >
              取消
            </Button>
            <Button
              type="submit"
            >
              <Plus className="w-4 h-4" />
              打开项目
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
