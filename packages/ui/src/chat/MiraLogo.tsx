interface MiraLogoProps {
  size?: number;
  className?: string;
}

export function MiraLogo({ size = 64, className = "" }: MiraLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="mira-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--primary)" />
          <stop offset="100%" stopColor="var(--fg-tertiary)" />
        </linearGradient>
        <linearGradient id="mira-inner" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--fg-secondary)" />
          <stop offset="100%" stopColor="var(--fg-quaternary)" />
        </linearGradient>
      </defs>
      {/* 背景圆角方形 */}
      <rect x="4" y="4" width="92" height="92" rx="24" fill="url(#mira-gradient)" />
      {/* 内部光效 */}
      <rect x="8" y="8" width="84" height="84" rx="20" fill="url(#mira-inner)" opacity="0.3" />
      {/* M 字母 */}
      <path
        d="M28 72V32L50 52L72 32V72"
        stroke="white"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* 装饰点 */}
      <circle cx="50" cy="28" r="3" fill="white" opacity="0.8" />
    </svg>
  );
}

export function MiraLogoSmall({ size = 32, className = "" }: MiraLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="mira-gradient-sm" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--primary)" />
          <stop offset="100%" stopColor="var(--fg-tertiary)" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="92" height="92" rx="24" fill="url(#mira-gradient-sm)" />
      <path
        d="M28 72V32L50 52L72 32V72"
        stroke="white"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="50" cy="28" r="3" fill="white" opacity="0.8" />
    </svg>
  );
}
