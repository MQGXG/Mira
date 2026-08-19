import { describe, it, expect } from "vitest";
import { routeToolMessage } from "./tool-router";

const mockTools = [
  { name: "read_file", description: "Read file contents", parameters: { properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file", parameters: {} },
  { name: "list_files", description: "List directory contents", parameters: {} },
  { name: "web_search", description: "Search the web", parameters: { properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "grep", description: "Search text in files", parameters: {} },
  { name: "glob", description: "Find files by pattern", parameters: {} },
  { name: "run_code", description: "Execute code", parameters: {} },
  { name: "bash", description: "Execute shell command", parameters: {} },
  { name: "edit_file", description: "Edit file content", parameters: {} },
];

describe("routeToolMessage", () => {
  it("匹配 read 命令到 read_file", () => {
    const result = routeToolMessage("read /path/to/file.txt", mockTools);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("read_file");
    expect(result!.args.path).toBe("/path/to/file.txt");
  });

  it("匹配 search 命令到 web_search", () => {
    const result = routeToolMessage("search 今天的天气", mockTools);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("web_search");
    expect(result!.args.query).toBe("今天的天气");
  });

  it("匹配 ls 命令到 list_files", () => {
    const result = routeToolMessage("ls", mockTools);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("list_files");
  });

  it("匹配 grep 命令到 grep", () => {
    const result = routeToolMessage("grep function", mockTools);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("grep");
    expect(result!.args.pattern).toBe("function");
  });

  it("匹配中文查找命令", () => {
    const result = routeToolMessage("搜索 TypeScript 教程", mockTools);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("web_search");
  });

  it("匹配 run 命令到 run_code", () => {
    const result = routeToolMessage("run console.log('hello')", mockTools);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("run_code");
  });

  it("不匹配普通对话文本（无命令前缀）", () => {
    const result = routeToolMessage("你好，今天过得怎么样？", mockTools);
    expect(result).toBeNull();
  });

  it("不匹配不认识的命令", () => {
    const result = routeToolMessage("xyz some random command", mockTools);
    expect(result).toBeNull();
  });
});
