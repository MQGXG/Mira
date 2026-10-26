/**
 * ImportSkillDialog — 「导入技能」对话框
 * 拖拽/点击选择 .zip 或 .md，或选择本地文件夹 → 风险扫描 → 自动安装到 ~/.config/mira/skills/<name>/
 * 「非高风险自动安装」勾选（默认开）：仅含文档的低风险包直接安装；检测到可执行文件/危险指令时展示风险清单待确认
 */

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp, FolderUp, Loader2 } from "lucide-react";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/button";
import { DialogService } from "../../services/dialog.service";
import { SkillService, type SkillImportResult } from "../../services/skill.service";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 导入成功后刷新列表 */
  onImported: () => void;
}

/** 导入目标：拖拽/选择的文件（zip/md）或本地文件夹路径 */
type ImportTarget =
  | { kind: "file"; file: File }
  | { kind: "folder"; path: string };

/** File → base64（去掉 data URL 前缀） */
async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function ImportSkillDialog({ open, onClose, onImported }: Props) {
  const [dragOver, setDragOver] = useState(false);
  /** 待导入目标（文件或文件夹） */
  const [target, setTarget] = useState<ImportTarget | null>(null);
  /** 非高风险自动安装（默认开） */
  const [autoInstall, setAutoInstall] = useState(true);
  const [busy, setBusy] = useState(false);
  /** 风险确认中的导入（展示风险清单） */
  const [pending, setPending] = useState<{ target: ImportTarget; result: SkillImportResult } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setTarget(null);
    setPending(null);
    setResult(null);
    setBusy(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function pickFiles(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    const isZip = f.name.toLowerCase().endsWith(".zip");
    const isMd = f.name.toLowerCase().endsWith(".md");
    if (!isZip && !isMd) {
      setResult({ ok: false, message: "仅支持 .zip 压缩包、单个 .md 文件或本地文件夹" });
      return;
    }
    setTarget({ kind: "file", file: f });
    setResult(null);
    setPending(null);
  }

  /** 选择本地文件夹导入（系统目录选择对话框，路径传给 sidecar 直接安装） */
  async function pickFolder() {
    const picked = await DialogService.openDirectory();
    if (!picked || picked.length === 0) return;
    setTarget({ kind: "folder", path: picked[0] });
    setResult(null);
    setPending(null);
  }

  /** 执行导入（confirmed = 已通过风险确认；skipRiskCheck = 跳过风险检测直接安装） */
  async function doImport(t: ImportTarget, opts: { confirmed?: boolean; skipRiskCheck?: boolean } = {}) {
    setBusy(true);
    setResult(null);
    try {
      let payload: Parameters<typeof SkillService.importSkill>[0];
      if (t.kind === "folder") {
        payload = { fileName: t.path.split(/[\\/]/).filter(Boolean).pop() ?? t.path, folderPath: t.path, ...opts, autoInstall };
      } else {
        const isZip = t.file.name.toLowerCase().endsWith(".zip");
        payload = isZip
          ? { fileName: t.file.name, zipBase64: await fileToBase64(t.file), ...opts, autoInstall }
          : { fileName: t.file.name, mdContent: await t.file.text(), ...opts, autoInstall };
      }
      const res = await SkillService.importSkill(payload);

      if (res.success) {
        setResult({ ok: true, message: `已安装「${res.name}」→ ${res.path ?? ""}` });
        setTarget(null);
        setPending(null);
        onImported();
        return;
      }
      if (res.needsConfirm) {
        setPending({ target: t, result: res });
        return;
      }
      setResult({ ok: false, message: res.error ?? "导入失败" });
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  /** 点击导入：后端按 autoInstall/风险分级决定直接安装或返回 needsConfirm 清单 */
  function handleImport() {
    if (!target || busy) return;
    doImport(target);
  }

  return (
    <Modal open={open} onClose={handleClose} title="导入技能" maxWidth="max-w-lg">
      <div className="space-y-4">
        {/* 拖拽/点击上传区 */}
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            pickFiles(e.dataTransfer.files);
          }}
          className="rounded-xl border-2 border-dashed py-10 flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors"
          style={{
            borderColor: dragOver ? "var(--primary)" : "var(--border-standard, rgba(255,255,255,0.12))",
            background: dragOver ? "color-mix(in srgb, var(--primary) 6%, transparent)" : "transparent",
          }}
        >
          <FileUp className="w-7 h-7 text-secondary" />
          <div className="text-sm text-secondary">拖拽文件或点击上传</div>
          {target && (
            <div className="text-xs font-mono text-primary">
              {target.kind === "folder" ? `📁 ${target.path}` : target.file.name}
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".zip,.md"
            className="hidden"
            onChange={(e) => pickFiles(e.target.files)}
          />
        </div>

        {/* 选择本地文件夹导入 */}
        <Button variant="outline" size="sm" onClick={pickFolder} disabled={busy} className="w-full h-8 text-xs gap-1.5">
          <FolderUp className="w-3.5 h-3.5" /> 选择文件夹导入
        </Button>

        {/* 非高风险自动安装 */}
        <label className="flex items-center gap-2 cursor-pointer w-fit">
          <input
            type="checkbox"
            checked={autoInstall}
            onChange={(e) => setAutoInstall(e.target.checked)}
            className="accent-[var(--primary)]"
          />
          <span className="text-sm text-secondary">非高风险自动安装</span>
        </label>

        {/* 文件要求 */}
        <div className="space-y-1.5">
          <div className="text-sm text-primary">文件要求</div>
          <ul className="text-xs text-secondary space-y-1 list-disc pl-4">
            <li>文件夹或者 .zip 需要包含 SKILL.md 文件</li>
            <li>.md 文件需包含 YAML 格式的技能名称和描述</li>
          </ul>
        </div>

        {/* 风险确认清单 */}
        {pending && (
          <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm text-yellow-500">
              <AlertTriangle className="w-4 h-4 shrink-0" /> 检测到风险内容，可等待确认或跳过检测直接安装
            </div>
            <ul className="text-xs text-secondary space-y-1 list-disc pl-4">
              {pending.result.risks.map((r, i) => (
                <li key={i}>{r.message}</li>
              ))}
            </ul>
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={() => doImport(pending.target, { confirmed: true })} disabled={busy} className="h-7 text-xs">
                确认安装
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => doImport(pending.target, { skipRiskCheck: true })}
                disabled={busy}
                title="跳过风险检测直接安装（结构性防护仍生效）"
                className="h-7 text-xs"
              >
                跳过检测，直接安装
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPending(null)} disabled={busy} className="h-7 text-xs">
                取消
              </Button>
            </div>
          </div>
        )}

        {/* 结果反馈 */}
        {result && (
          <div
            className="rounded-lg p-3 text-xs flex items-start gap-2"
            style={{
              background: result.ok ? "color-mix(in srgb, #22c55e 10%, transparent)" : "color-mix(in srgb, #ef4444 10%, transparent)",
              color: result.ok ? "#22c55e" : "#ef4444",
            }}
          >
            {result.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            <span className="break-all">{result.message}</span>
          </div>
        )}

        {/* 操作 */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={handleClose} className="h-8 text-xs">
            关闭
          </Button>
          <Button size="sm" onClick={handleImport} disabled={!target || busy} className="h-8 text-xs gap-1.5">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            导入
          </Button>
        </div>
      </div>
    </Modal>
  );
}
