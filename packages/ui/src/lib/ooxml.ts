/**
 * OOXML 文档解析（Word .docx / PowerPoint .pptx → 智能 Markdown/HTML）
 *
 * 依赖：jszip（解压 ZIP）+ DOMParser（浏览器原生 XML 解析）
 *
 * 智能双格式：
 * - 含复杂结构（合并单元格 / 内嵌图片 / 嵌套表格）→ HTML 片段（完整还原）
 * - 纯文本/简单表格 → Markdown（省 token）
 */

import JSZip from "jszip";

// OOXML 命名空间
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

export interface OoxmlResult {
  /** 智能判断：true 用 HTML 渲染，false 用 Markdown/文本 */
  format: "html" | "markdown";
  /** 转换后的内容（HTML 片段或 Markdown 文本） */
  content: string;
  /** 文档内提取的内嵌图片（key = 文件名） */
  images: Record<string, string>;
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

function elText(el: Element | null): string {
  if (!el) return "";
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

// ── Word (.docx) ─────────────────────────────────────

function wordHasComplexStructure(body: Element): boolean {
  const xml = body.ownerDocument;
  // 合并单元格（w:gridSpan / w:vMerge）
  if (xml.getElementsByTagNameNS(W_NS, "gridSpan").length > 0) return true;
  if (xml.getElementsByTagNameNS(W_NS, "vMerge").length > 0) return true;
  // 内嵌图片（w:drawing）
  if (xml.getElementsByTagNameNS(W_NS, "drawing").length > 0) return true;
  // 嵌套表格
  const tables = body.getElementsByTagNameNS(W_NS, "tbl");
  for (const tbl of Array.from(tables)) {
    if (tbl.getElementsByTagNameNS(W_NS, "tbl").length > 0) return true;
  }
  return false;
}

function docxParagraphToHtml(p: Element, images: Record<string, string>, rIdMap: Map<string, string>): string {
  const style = p.getElementsByTagNameNS(W_NS, "pStyle")[0];
  const styleVal = style?.getAttributeNS(W_NS, "val") || "";
  let text = "";
  // 收集段落内所有 w:t 与图片
  for (const child of Array.from(p.children)) {
    if (child.localName === "drawing") {
      const blip = child.getElementsByTagNameNS(A_NS, "blip")[0];
      const rId = blip?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed");
      if (rId) {
        const target = rIdMap.get(rId);
        if (target) {
          const fileName = target.split("/").pop() || "image";
          const dataUrl = images[fileName];
          if (dataUrl) text += `<img src="${dataUrl}" alt="${fileName}">`;
        }
      }
      continue;
    }
    if (child.localName === "t" || child.localName === "delText") {
      text += child.textContent || "";
    } else if (child.localName === "tab") {
      text += "\t";
    } else if (child.localName === "br") {
      text += "\n";
    } else {
      // 递归（w:r > w:t 等）
      text += elText(child);
    }
  }
  text = text.trim();
  if (!text) return "";

  if (/^Heading1$/.test(styleVal)) return `<h1>${text}</h1>`;
  if (/^Heading2$/.test(styleVal)) return `<h2>${text}</h2>`;
  if (/^Heading3$/.test(styleVal)) return `<h3>${text}</h3>`;
  if (/^Title$/.test(styleVal)) return `<h1>${text}</h1>`;
  if (/ListParagraph/.test(styleVal)) return `<li>${text}</li>`;
  return `<p>${text}</p>`;
}

function docxTableToHtml(tbl: Element, images: Record<string, string>, rIdMap: Map<string, string>): string {
  const rows: string[] = [];
  const trs = tbl.getElementsByTagNameNS(W_NS, "tr");
  for (const tr of Array.from(trs)) {
    const cells: string[] = [];
    const tcs = tr.getElementsByTagNameNS(W_NS, "tc");
    for (const tc of Array.from(tcs)) {
      const tcPr = tc.getElementsByTagNameNS(W_NS, "tcPr")[0];
      let colspan = 1;
      let rowspan = 1;
      if (tcPr) {
        const gs = tcPr.getElementsByTagNameNS(W_NS, "gridSpan")[0];
        const vm = tcPr.getElementsByTagNameNS(W_NS, "vMerge")[0];
        if (gs) colspan = parseInt(gs.getAttributeNS(W_NS, "val") || "1", 10) || 1;
        if (vm && vm.getAttributeNS(W_NS, "val") !== "restart") rowspan = 0; // continue 合并
      }
      // 单元格内容：段落拼接
      let cellHtml = "";
      const ps = tc.getElementsByTagNameNS(W_NS, "p");
      for (const p of Array.from(ps)) {
        cellHtml += docxParagraphToHtml(p, images, rIdMap);
      }
      const attr = `${colspan > 1 ? ` colspan="${colspan}"` : ""}${rowspan > 1 ? ` rowspan="${rowspan}"` : ""}`;
      cells.push(`<td${attr}>${cellHtml}</td>`);
    }
    rows.push(`<tr>${cells.join("")}</tr>`);
  }
  return `<table>${rows.join("")}</table>`;
}

/**
 * 解析 .docx → 智能 Markdown/HTML。
 * @param buffer 文件 ArrayBuffer
 * @param images 输出参数：文档内嵌图片 base64
 */
export async function docxToContent(buffer: ArrayBuffer, images: Record<string, string>): Promise<OoxmlResult> {
  const zip = await JSZip.loadAsync(buffer);

  // 读取图片资源（word/media/*）
  const mediaFiles = Object.keys(zip.files).filter((p) => p.startsWith("word/media/"));
  for (const mediaPath of mediaFiles) {
    const file = zip.files[mediaPath];
    if (!file || file.dir) continue;
    const mime = /\.png$/i.test(mediaPath) ? "image/png"
      : /\.jpe?g$/i.test(mediaPath) ? "image/jpeg"
      : /\.gif$/i.test(mediaPath) ? "image/gif"
      : /\.webp$/i.test(mediaPath) ? "image/webp"
      : "application/octet-stream";
    const data = await file.async("base64");
    images[mediaPath.split("/").pop()!] = `data:${mime};base64,${data}`;
  }

  // 读取 rId 映射
  const rIdMap = new Map<string, string>();
  const relsFile = zip.files["word/_rels/document.xml.rels"];
  if (relsFile) {
    const relsXml = await relsFile.async("string");
    const relsDoc = parseXml(relsXml);
    const rels = relsDoc.getElementsByTagName("Relationship");
    for (const rel of Array.from(rels)) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      if (id && target) rIdMap.set(id, target.replace(/^\.\//, "word/"));
    }
  }

  // 读取正文
  const docFile = zip.files["word/document.xml"];
  if (!docFile) return { format: "markdown", content: "（无法读取 Word 文档内容）", images };
  const docXml = await docFile.async("string");
  const doc = parseXml(docXml);
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) return { format: "markdown", content: "（文档内容为空）", images };

  const isComplex = wordHasComplexStructure(body);
  if (isComplex) {
    // HTML：遍历 body 直接子节点（段落/表格/节）
    const parts: string[] = [];
    for (const node of Array.from(body.children)) {
      if (node.localName === "p") {
        const h = docxParagraphToHtml(node, images, rIdMap);
        if (h) parts.push(h);
      } else if (node.localName === "tbl") {
        parts.push(docxTableToHtml(node, images, rIdMap));
      } else if (node.localName === "sectPr") {
        continue;
      }
    }
    return { format: "html", content: parts.join("\n"), images };
  }

  // Markdown：纯文本 + 简单表格
  const parts: string[] = [];
  for (const node of Array.from(body.children)) {
    if (node.localName === "p") {
      const text = elText(node).trim();
      if (text) parts.push(text);
    } else if (node.localName === "tbl") {
      parts.push(docxTableToMarkdown(node));
    }
  }
  return { format: "markdown", content: parts.join("\n\n"), images };
}

function docxTableToMarkdown(tbl: Element): string {
  const rows: string[][] = [];
  const trs = tbl.getElementsByTagNameNS(W_NS, "tr");
  for (const tr of Array.from(trs)) {
    const cells: string[] = [];
    const tcs = tr.getElementsByTagNameNS(W_NS, "tc");
    for (const tc of Array.from(tcs)) {
      const ps = tc.getElementsByTagNameNS(W_NS, "p");
      const cellText = Array.from(ps).map((p) => elText(p)).join(" ").replace(/\|/g, "\\|");
      cells.push(cellText.trim());
    }
    rows.push(cells);
  }
  if (rows.length === 0) return "";
  const header = rows[0];
  const sep = header.map(() => "---");
  const body = rows.slice(1).map((r) => `| ${r.join(" | ")} |`);
  return [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`, ...body].join("\n");
}

// ── PowerPoint (.pptx) ────────────────────────────────

/**
 * 解析 .pptx → 智能 Markdown/HTML。
 */
export async function pptxToContent(buffer: ArrayBuffer, images: Record<string, string>): Promise<OoxmlResult> {
  const zip = await JSZip.loadAsync(buffer);

  // 图片资源（ppt/media/*）
  const mediaFiles = Object.keys(zip.files).filter((p) => p.startsWith("ppt/media/"));
  for (const mediaPath of mediaFiles) {
    const file = zip.files[mediaPath];
    if (!file || file.dir) continue;
    const mime = /\.png$/i.test(mediaPath) ? "image/png"
      : /\.jpe?g$/i.test(mediaPath) ? "image/jpeg"
      : /\.gif$/i.test(mediaPath) ? "image/gif"
      : /\.webp$/i.test(mediaPath) ? "image/webp"
      : "application/octet-stream";
    const data = await file.async("base64");
    images[mediaPath.split("/").pop()!] = `data:${mime};base64,${data}`;
  }

  // 每张幻灯片的文本 + 表格
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)![1], 10);
      const nb = parseInt(b.match(/slide(\d+)/)![1], 10);
      return na - nb;
    });

  const slides: Array<{ html: string; md: string; complex: boolean }> = [];

  for (const slidePath of slidePaths) {
    const file = zip.files[slidePath];
    const xml = await file.async("string");
    const doc = parseXml(xml);

    // 幻灯片文本（a:t）
    const texts: string[] = [];
    const tEls = doc.getElementsByTagNameNS(A_NS, "t");
    for (const t of Array.from(tEls)) {
      const text = (t.textContent || "").trim();
      if (text) texts.push(text);
    }

    // 表格
    const tables = doc.getElementsByTagNameNS(A_NS, "tbl");
    const hasTable = tables.length > 0;
    const hasImage = doc.getElementsByTagNameNS(A_NS, "blip").length > 0;
    const complex = hasTable || hasImage || texts.some((t) => t.length > 200);

    const htmlParts: string[] = [];
    for (const tbl of Array.from(tables)) {
      htmlParts.push(drawingTableToHtml(tbl));
    }
    const mdParts: string[] = [];
    for (const tbl of Array.from(tables)) {
      mdParts.push(drawingTableToMarkdown(tbl));
    }

    slides.push({
      complex,
      html: [...texts.map((t) => `<p>${t}</p>`), ...htmlParts].join("\n"),
      md: [...texts, ...mdParts].join("\n\n"),
    });
  }

  const anyComplex = slides.some((s) => s.complex);
  if (anyComplex) {
    const content = slides.map((s, i) => `<h3>幻灯片 ${i + 1}</h3>\n${s.html}`).join("\n\n");
    return { format: "html", content, images };
  }
  const content = slides.map((s, i) => `## 幻灯片 ${i + 1}\n\n${s.md}`).join("\n\n");
  return { format: "markdown", content, images };
}

function drawingTableToHtml(tbl: Element): string {
  const rows: string[] = [];
  const trs = tbl.getElementsByTagNameNS(A_NS, "tr");
  for (const tr of Array.from(trs)) {
    const cells: string[] = [];
    const tcs = tr.getElementsByTagNameNS(A_NS, "tc");
    for (const tc of Array.from(tcs)) {
      const text = elText(tc).replace(/\|/g, "\\|");
      cells.push(`<td>${text}</td>`);
    }
    rows.push(`<tr>${cells.join("")}</tr>`);
  }
  return `<table>${rows.join("")}</table>`;
}

function drawingTableToMarkdown(tbl: Element): string {
  const rows: string[][] = [];
  const trs = tbl.getElementsByTagNameNS(A_NS, "tr");
  for (const tr of Array.from(trs)) {
    const cells: string[] = [];
    const tcs = tr.getElementsByTagNameNS(A_NS, "tc");
    for (const tc of Array.from(tcs)) {
      cells.push(elText(tc).replace(/\|/g, "\\|").trim());
    }
    rows.push(cells);
  }
  if (rows.length === 0) return "";
  const header = rows[0];
  const sep = header.map(() => "---");
  const body = rows.slice(1).map((r) => `| ${r.join(" | ")} |`);
  return [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`, ...body].join("\n");
}

// ── 统一导出 ─────────────────────────────────────────

/**
 * 按扩展名解析 Office 文档。
 * @returns OoxmlResult | null（不支持的格式返回 null）
 */
export async function parseOfficeFile(
  fileName: string,
  buffer: ArrayBuffer,
): Promise<OoxmlResult | null> {
  const ext = fileName.toLowerCase().split(".").pop() || "";
  if (ext === "docx") return docxToContent(buffer, {});
  if (ext === "pptx") return pptxToContent(buffer, {});
  return null;
}
