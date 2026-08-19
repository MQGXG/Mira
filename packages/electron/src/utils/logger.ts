import { app } from "electron";
import { join } from "path";
import { existsSync, mkdirSync, appendFileSync, createWriteStream } from "fs";

let logFilePath: string;

function ensureLogDir(): string {
  const userData = app.getPath("userData");
  const logsDir = join(userData, "logs");
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  return logsDir;
}

export function initLogger(): void {
  const logsDir = ensureLogDir();
  const date = new Date().toISOString().split("T")[0];
  logFilePath = join(logsDir, `mira-${date}.log`);
}

export function getLogFilePath(): string {
  return logFilePath;
}

export function logToFile(level: "INFO" | "ERROR" | "WARN", message: string): void {
  if (!logFilePath) return;
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}\n`;
  try {
    appendFileSync(logFilePath, line);
  } catch {
    // ignore
  }
}

// 可选：将 console 重定向到文件和控制台同时输出
export function patchConsole(): void {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    logToFile("INFO", msg);
    originalLog(...args);
  };

  console.error = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    logToFile("ERROR", msg);
    originalError(...args);
  };

  console.warn = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    logToFile("WARN", msg);
    originalWarn(...args);
  };
}

export function createPythonLogStream() {
  const logsDir = ensureLogDir();
  const date = new Date().toISOString().split("T")[0];
  const pythonLogPath = join(logsDir, `python-${date}.log`);
  return createWriteStream(pythonLogPath, { flags: "a" });
}

export function getLogsDir(): string {
  return ensureLogDir();
}
