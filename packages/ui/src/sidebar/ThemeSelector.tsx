import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "../contexts/ThemeContext";

export function ThemeSelector() {
  const { theme, resolvedTheme, setTheme } = useTheme();

  const options = [
    { value: "light" as const, label: "浅色", icon: Sun },
    { value: "dark" as const, label: "暗色", icon: Moon },
    { value: "system" as const, label: "跟随系统", icon: Monitor },
  ];

  return (
    <div className="p-4 rounded-xl" style={{ background: 'var(--surface-secondary)', border: '1px solid var(--border)' }}>
      <div className="text-sm mb-3" style={{ color: 'var(--text-primary)' }}>外观</div>
      <div className="flex gap-2">
        {options.map((option) => {
          const Icon = option.icon;
          const isActive = theme === option.value;
          return (
            <button
              key={option.value}
              onClick={() => setTheme(option.value)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all duration-200"
              style={{
                border: isActive ? '1px solid color-mix(in srgb, var(--primary) 30%, transparent)' : '1px solid var(--border)',
                background: isActive ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : 'transparent',
                color: isActive ? 'var(--primary)' : 'var(--text-secondary)',
              }}
            >
              <Icon className="w-4 h-4" />
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>
        当前: {resolvedTheme === "dark" ? "暗色模式" : "浅色模式"} ({theme === "system" ? "跟随系统" : "手动设置"})
      </p>
    </div>
  );
}
