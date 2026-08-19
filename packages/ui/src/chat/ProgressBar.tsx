export function ProgressBar() {
  return (
    <div className="w-full h-0.5 overflow-hidden" style={{ background: "var(--border-subtle)" }}>
      <div className="h-full w-1/3 rounded-full animate-progress" style={{ background: "var(--primary)" }} />
    </div>
  );
}
