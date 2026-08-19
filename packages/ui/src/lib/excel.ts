/**
 * Excel 解析（SheetJS xlsx → 智能 CSV/HTML）
 *
 * - 无合并单元格 → CSV（紧凑、省 token）
 * - 含合并单元格 → HTML 表格（完整还原）
 */

export interface ExcelResult {
  format: "html" | "csv";
  content: string;
  /** sheet 名列表 */
  sheetNames: string[];
}

/**
 * 解析 Excel 文件为 CSV 或 HTML。
 * @param buffer 文件 ArrayBuffer
 * @param maxRows 每 sheet 最多解析行数（防止超长 sheet 爆 token）
 */
export async function excelToContent(buffer: ArrayBuffer, maxRows = 200): Promise<ExcelResult> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });

  const sheetNames = wb.SheetNames;
  const anyComplex = sheetNames.some((name) => {
    const ws = wb.Sheets[name];
    return ws && Array.isArray(ws["!merges"]) && ws["!merges"].length > 0;
  });

  if (anyComplex) {
    // HTML：多 sheet + 合并单元格保留
    const parts: string[] = [];
    for (const name of sheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      let html = XLSX.utils.sheet_to_html(ws, { id: `sheet-${name}` });
      // 限制行数（sheet_to_html 无直接限制，截断尾部行）
      const rows = html.match(/<tr[\s>]/gi)?.length || 0;
      if (rows > maxRows) {
        const idx = nthIndexOf(html, "<tr", maxRows);
        if (idx > 0) html = html.slice(0, idx) + `</table><!-- 已截断，共 ${rows} 行 -->`;
      }
      parts.push(`<h3>工作表：${name}</h3>\n${html}`);
    }
    return { format: "html", content: parts.join("\n\n"), sheetNames };
  }

  // CSV：多 sheet 拼接
  const parts: string[] = [];
  for (const name of sheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    let csv = XLSX.utils.sheet_to_csv(ws);
    const lines = csv.split("\n");
    if (lines.length > maxRows) {
      csv = lines.slice(0, maxRows).join("\n") + `\n... (已截断，共 ${lines.length} 行)`;
    }
    parts.push(`## 工作表：${name}\n\n${csv}`);
  }
  return { format: "csv", content: parts.join("\n\n"), sheetNames };
}

function nthIndexOf(str: string, sub: string, n: number): number {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = str.indexOf(sub, idx + 1);
    if (idx === -1) return -1;
  }
  return idx;
}
