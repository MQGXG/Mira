/**
 * Widget 测试台入口 — 单独渲染各类 widget 用于测试
 * 通过 widget-test.html 访问，逐类验证 iframe 沙箱渲染。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WidgetRenderer } from "./widget-renderer";
import { extractWidgetBlocks } from "./widget-utils";

// ── ① Diagram：SVG 流程图 ──────────────────────────────
const diagramWidget = `
<div style="font-size:13px;font-weight:500;margin-bottom:10px;">① Diagram · SVG 流程图</div>
<svg viewBox="0 0 680 180" width="100%" role="img">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M2 1L8 5L2 9" fill="none" stroke="#888" stroke-width="1.5" stroke-linecap="round"/>
    </marker>
  </defs>
  <rect x="40" y="40" width="160" height="48" rx="10" fill="#E1F5EE" stroke="#0F6E56"/>
  <text x="120" y="70" text-anchor="middle" dominant-baseline="central" font-size="14" fill="#085041">开始</text>
  <line x1="200" y1="64" x2="250" y2="64" stroke="#888" stroke-width="1.5" marker-end="url(#arrow)"/>
  <rect x="255" y="40" width="160" height="48" rx="10" fill="#E1F5EE" stroke="#0F6E56"/>
  <text x="335" y="70" text-anchor="middle" dominant-baseline="central" font-size="14" fill="#085041">处理</text>
  <line x1="415" y1="64" x2="465" y2="64" stroke="#888" stroke-width="1.5" marker-end="url(#arrow)"/>
  <rect x="470" y="40" width="160" height="48" rx="10" fill="#E1F5EE" stroke="#0F6E56"/>
  <text x="550" y="70" text-anchor="middle" dominant-baseline="central" font-size="14" fill="#085041">结束</text>
</svg>`;

// ── ② Chart：Chart.js 柱状图 ─────────────────────────────
const chartWidget = `
<div style="font-size:13px;font-weight:500;margin-bottom:10px;">② Chart · Chart.js 柱状图</div>
<div style="position:relative;width:100%;height:280px;">
  <canvas id="wbChart" role="img" aria-label="本周交付量柱状图">柱状图</canvas>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
new Chart(document.getElementById('wbChart'), {
  type: 'bar',
  data: {
    labels: ['文档生成', '数据分析', 'PPT报告', '代码开发', '邮件周报'],
    datasets: [{ label: '交付量', data: [14, 9, 7, 11, 5], backgroundColor: ['#378ADD', '#378ADD', '#378ADD', '#D85A30', '#378ADD'], borderRadius: 4 }]
  },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
});
</script>`;

// ── ③ Interactive：HTML 交互组件 ─────────────────────────
const interactiveWidget = `
<div style="font-size:13px;font-weight:500;margin-bottom:10px;">③ Interactive · 模式切换</div>
<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
  <button id="tab-a" onclick="pick('a')">模式 A</button>
  <button id="tab-b" onclick="pick('b')">模式 B</button>
  <button id="tab-c" onclick="pick('c')">模式 C</button>
</div>
<div id="card" style="border:1px solid #d0d0d0;border-radius:8px;padding:14px;">
  <p id="desc" style="margin:0;font-size:13px;color:#444;"></p>
</div>
<script>
var modes = {
  a: { d: '模式 A：直接执行任务，交付成果。' },
  b: { d: '模式 B：先分析规划，确认后执行。' },
  c: { d: '模式 C：只回答分析，不做任何修改。' }
};
function pick(m) {
  var info = modes[m];
  document.getElementById('desc').textContent = info.d;
  ['a','b','c'].forEach(function(k) {
    var b = document.getElementById('tab-' + k);
    b.style.border = (k === m) ? '2px solid #378ADD' : '1px solid #ccc';
  });
}
pick('a');
</script>`;

// ── ④ Mockup：SVG 线框图 ────────────────────────────────
const mockupWidget = `
<div style="font-size:13px;font-weight:500;margin-bottom:10px;">④ Mockup · 界面线框图</div>
<svg viewBox="0 0 680 240" width="100%" role="img">
  <rect x="20" y="20" width="640" height="200" rx="10" fill="#fff" stroke="#888780"/>
  <circle cx="40" cy="40" r="8" fill="#534AB7"/>
  <text x="55" y="40" dominant-baseline="central" font-size="12" fill="#26215C">App 工作台</text>
  <line x1="30" y1="55" x2="650" y2="55" stroke="#B4B2A9"/>
  <text x="35" y="72" font-size="11" fill="#444">侧边栏</text>
  <rect x="35" y="82" width="120" height="18" rx="4" fill="#F1EFE8"/>
  <rect x="35" y="106" width="120" height="18" rx="4" fill="#F1EFE8"/>
  <text x="175" y="72" font-size="11" fill="#444">对话区</text>
  <rect x="175" y="82" width="240" height="20" rx="8" fill="#E6F1FB" stroke="#85B7EB"/>
  <rect x="175" y="140" width="240" height="40" rx="8" fill="#F1EFE8"/>
  <text x="455" y="72" font-size="11" fill="#444">结果区</text>
  <rect x="455" y="82" width="180" height="70" rx="8" fill="#F1EFE8" stroke="#B4B2A9"/>
  <rect x="465" y="92" width="90" height="8" rx="3" fill="#D3D1C7"/>
</svg>`;

// ── ⑤ Art：SVG 艺术插画 ─────────────────────────────────
const artWidget = `
<div style="font-size:13px;font-weight:500;margin-bottom:10px;">⑤ Art · SVG 艺术插画</div>
<svg viewBox="0 0 400 300" width="100%" role="img">
  <circle cx="200" cy="150" r="120" fill="none" stroke="#E1F5EE"/>
  <g fill="#F0997B">
    <circle cx="200" cy="40" r="4"/>
    <circle cx="200" cy="40" r="4" transform="rotate(60 200 150)"/>
    <circle cx="200" cy="40" r="4" transform="rotate(120 200 150)"/>
    <circle cx="200" cy="40" r="4" transform="rotate(180 200 150)"/>
    <circle cx="200" cy="40" r="4" transform="rotate(240 200 150)"/>
    <circle cx="200" cy="40" r="4" transform="rotate(300 200 150)"/>
  </g>
  <ellipse cx="200" cy="90" rx="18" ry="34" fill="#5DCAA5" stroke="#1D9E75"/>
  <ellipse cx="200" cy="90" rx="18" ry="34" fill="#FAC775" stroke="#EF9F27" transform="rotate(60 200 150)"/>
  <ellipse cx="200" cy="90" rx="18" ry="34" fill="#5DCAA5" stroke="#1D9E75" transform="rotate(120 200 150)"/>
  <ellipse cx="200" cy="90" rx="18" ry="34" fill="#FAC775" stroke="#EF9F27" transform="rotate(180 200 150)"/>
  <ellipse cx="200" cy="90" rx="18" ry="34" fill="#5DCAA5" stroke="#1D9E75" transform="rotate(240 200 150)"/>
  <ellipse cx="200" cy="90" rx="18" ry="34" fill="#FAC775" stroke="#EF9F27" transform="rotate(300 200 150)"/>
  <polygon points="200,132 215,141 215,159 200,168 185,159 185,141" fill="#534AB7"/>
</svg>`;

// ── 完整消息（含 widget 块）测试提取逻辑 ─────────────────
const messageWithWidget = "这里是一些说明文字。\n\n" +
  "```html\n<div style=\"padding:8px;border:1px solid #4ade80;border-radius:8px;\">绿色提示框 widget</div>\n```\n\n" +
  "然后继续正文。";

function App() {
  const cases = [
    { label: "Diagram · SVG 流程图", html: diagramWidget },
    { label: "Chart · Chart.js 柱状图", html: chartWidget },
    { label: "Interactive · 交互组件", html: interactiveWidget },
    { label: "Mockup · 界面线框图", html: mockupWidget },
    { label: "Art · SVG 艺术插画", html: artWidget },
  ];

  // 提取逻辑测试
  const extracted = extractWidgetBlocks(messageWithWidget);

  return (
    <div>
      <div className="section">
        <div className="section-title">extractWidgetBlocks 提取逻辑测试</div>
        <div className="section-desc">
          输入消息含一个 widget 块。提取结果：cleanText 是否不含 ```html？widgets 数量是否正确？
        </div>
        <div className="card">
          <div className="card-label">提取结果</div>
          <pre style={{ fontSize: 11, color: "#555", whiteSpace: "pre-wrap" }}>
{`widgets 数: ${extracted.widgets.length}
cleanText 含 '说明文字': ${extracted.cleanText.includes("说明文字")}
cleanText 含 '` + "```" + `html': ${extracted.cleanText.includes("```html")}`}
          </pre>
        </div>
      </div>

      <div className="section">
        <div className="section-title">5 类可视化逐个渲染</div>
        <div className="section-desc">每个用例用独立 WidgetRenderer（iframe 沙箱）渲染</div>
        <div className="grid">
          {cases.map((c, i) => (
            <div className="card" key={i}>
              <div className="card-label">{c.label}</div>
              <WidgetRenderer html={c.html} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
