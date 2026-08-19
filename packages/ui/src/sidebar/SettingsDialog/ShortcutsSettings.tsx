export function ShortcutsSettings() {
  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium text-primary">快捷键</h3>
      <div className="text-xs text-secondary">以下快捷键可在应用中直接使用</div>
      <div className="space-y-2">
        <div className="flex items-center justify-between p-4 rounded-xl bg-surface-secondary border border-standard">
          <span className="text-sm text-primary">全局唤出</span>
          <span className="text-xs font-mono px-2 py-1 rounded text-secondary bg-input border border-input">Ctrl + Shift + A</span>
        </div>
        <div className="flex items-center justify-between p-4 rounded-xl bg-surface-secondary border border-standard">
          <span className="text-sm text-primary">新建会话</span>
          <span className="text-xs font-mono px-2 py-1 rounded text-secondary bg-input border border-input">Ctrl + N</span>
        </div>
        <div className="flex items-center justify-between p-4 rounded-xl bg-surface-secondary border border-standard">
          <span className="text-sm text-primary">关闭窗口</span>
          <span className="text-xs font-mono px-2 py-1 rounded text-secondary bg-input border border-input">Ctrl + W</span>
        </div>
        <div className="flex items-center justify-between p-4 rounded-xl bg-surface-secondary border border-standard">
          <span className="text-sm text-primary">发送消息</span>
          <span className="text-xs font-mono px-2 py-1 rounded text-secondary bg-input border border-input">Enter</span>
        </div>
        <div className="flex items-center justify-between p-4 rounded-xl bg-surface-secondary border border-standard">
          <span className="text-sm text-primary">换行</span>
          <span className="text-xs font-mono px-2 py-1 rounded text-secondary bg-input border border-input">Shift + Enter</span>
        </div>
      </div>
    </div>
  );
}
