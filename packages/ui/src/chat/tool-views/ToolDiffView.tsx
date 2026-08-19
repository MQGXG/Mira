import { DiffViewer } from "../../components/assistant-ui/diff-viewer";

interface Props {
  result: string;
  args: Record<string, unknown>;
  name: string;
}

export function ToolDiffView({ result, args, name }: Props) {
  const filePath = (args.path as string) || "";

  if (name === "write_file" && args.content) {
    const content = String(args.content);
    return (
      <DiffViewer
        oldFile={{ content: "", name: filePath }}
        newFile={{ content, name: filePath }}
        showStats={false}
        showIcon={false}
        viewMode="unified"
      />
    );
  }

  const oldStr = (args.oldString as string) || "";
  const newStr = (args.newString as string) || "";
  const resultLines = result.split("\n");
  if (resultLines[0]?.startsWith("✅") || resultLines[0]?.startsWith("❌")) {
    return (
      <div className="text-xs px-3 py-2" style={{ color: 'var(--text-secondary)' }}>
        {result}
      </div>
    );
  }

  return (
    <DiffViewer
      oldFile={{ content: oldStr, name: filePath }}
      newFile={{ content: newStr, name: filePath }}
      showStats={false}
      showIcon={false}
      viewMode="unified"
    />
  );
}
