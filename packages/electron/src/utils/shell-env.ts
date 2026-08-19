import { execSync } from "child_process";

export function loadShellEnv(): Record<string, string> {
  try {
    if (process.platform === "win32") {
      // Windows: 用 cmd /c 获取 PATH
      const result = execSync(
        'cmd /c "echo %PATH%"',
        { encoding: "utf8", timeout: 3000 }
      ).trim();
      return { PATH: result };
    } else {
      // macOS / Linux: 从默认 shell 获取环境变量
      const shell = process.env.SHELL || "/bin/bash";
      const result = execSync(
        `${shell} -l -c 'echo "PATH=$PATH"' 2>/dev/null || echo "PATH=$PATH"`,
        { encoding: "utf8", timeout: 3000 }
      ).trim();
      const env: Record<string, string> = {};
      for (const line of result.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) {
          env[line.slice(0, eq)] = line.slice(eq + 1);
        }
      }
      return env;
    }
  } catch {
    return {};
  }
}

export function injectShellEnv(): void {
  const shellEnv = loadShellEnv();
  if (shellEnv.PATH) {
    const currentPath = process.env.PATH || "";
    const paths = shellEnv.PATH.split(";").map((p) => p.trim()).filter(Boolean);
    for (const p of paths) {
      if (!currentPath.toUpperCase().includes(p.toUpperCase())) {
        process.env.PATH = `${p};${process.env.PATH}`;
      }
    }
  }
}
