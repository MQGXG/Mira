/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./packages/**/*.{js,ts,jsx,tsx}",
    "./apps/**/*.{js,ts,jsx,tsx}",
    "./node_modules/streamdown/dist/*.js",
    "./node_modules/@streamdown/code/dist/*.js",
    "./node_modules/@streamdown/mermaid/dist/*.js",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
          background: "var(--background)",
          foreground: "var(--foreground)",
          card: { DEFAULT: "var(--card)", foreground: "var(--card-foreground)" },
          popover: { DEFAULT: "var(--popover)", foreground: "var(--popover-foreground)" },
          primary: { DEFAULT: "var(--primary)", foreground: "var(--primary-foreground)" },
          secondary: { DEFAULT: "var(--secondary)", foreground: "var(--secondary-foreground)" },
          muted: { DEFAULT: "var(--muted)", foreground: "var(--muted-foreground)" },
          destructive: { DEFAULT: "var(--destructive)", foreground: "var(--destructive-foreground)" },
          accent: { DEFAULT: "var(--accent)", foreground: "var(--accent-foreground)" },
          border: "var(--border)",
          input: "var(--input)",
          ring: "var(--ring)",
        // 功能色
        success: "var(--success)",
        warning: "var(--warning)",
        info: "var(--info)",
        error: "var(--error)",
      },
      backgroundImage: {
        "gradient-primary": "linear-gradient(135deg, #3b82f6, #06b6d4)",
        "gradient-primary-hover": "linear-gradient(135deg, #60a5fa, #22d3ee)",
        "gradient-primary-subtle": "linear-gradient(135deg, rgba(59,130,246,0.12), rgba(6,182,212,0.12))",
        "gradient-brand": "linear-gradient(135deg, #3b82f6, #06b6d4)",
        "gradient-brand-glow": "linear-gradient(135deg, rgba(59,130,246,0.8), rgba(6,182,212,0.8))",
        "gradient-user-msg": "linear-gradient(135deg, #3b82f6, #06b6d4)",
      },
      boxShadow: {
        "glow-primary": "0 0 0 3px rgba(59, 130, 246, 0.2)",
        "glow-primary-lg": "0 0 20px rgba(59, 130, 246, 0.15)",
        "glow-accent": "0 0 0 3px rgba(6, 182, 212, 0.2)",
        "glass": "0 8px 32px rgba(0, 0, 0, 0.24)",
        "glass-lg": "0 16px 48px rgba(0, 0, 0, 0.32)",
        "card": "0 2px 8px rgba(0, 0, 0, 0.08)",
        "card-hover": "0 8px 24px rgba(0, 0, 0, 0.12)",
      },
      borderRadius: {
        "card": "16px",
        "button": "24px",
        "input": "12px",
      },
      animation: {
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
        "fade-in-up": "fade-in-up 0.3s ease-out",
        "scale-in": "scale-in 0.2s ease-out",
        "slide-in-right": "slide-in-right 0.25s ease-out",
        "bounce-dot": "bounce-dot 1.4s ease-in-out infinite",
        "in": "in 0.2s ease-out",
        "out": "out 0.2s ease-in",
        "progress": "progress 1.5s ease-in-out infinite",
      },
      keyframes: {
        "progress": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
        "pulse-glow": {
          "0%, 100%": { opacity: "1", filter: "brightness(1)" },
          "50%": { opacity: "0.7", filter: "brightness(1.3)" },
        },
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.95)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "slide-in-right": {
          "0%": { opacity: "0", transform: "translateX(-8px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "bounce-dot": {
          "0%, 80%, 100%": { transform: "scale(0)" },
          "40%": { transform: "scale(1)" },
        },
        "in": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "out": {
          "0%": { opacity: "1", transform: "translateY(0)" },
          "100%": { opacity: "0", transform: "translateY(4px)" },
        },
      },
      fontFamily: {
        sans: ["Inter", "SF Pro Display", "PingFang SC", "Microsoft YaHei", "sans-serif"],
        mono: ["Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", "monospace"],
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
