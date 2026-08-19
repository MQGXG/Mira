# Obsidian 知识图谱启发 — Mira 落地分析

> 参考 Obsidian 官方文档（obsidianmd/obsidian-help）：Internal links / Backlinks / Graph view / Aliases。
> 目标：把 Obsidian 的"双向链接 + 知识图谱 + 意外连接"体验，结合 Mira 已有的向量记忆与动态记忆图谱，做成本地优先的 AI 原生版本。

## 一、Obsidian 核心机制（官方定义）

### 1. 双向链接（Internal Links）
- 语法 `[[笔记名]]` / `[[笔记名|显示文本]]`，支持链接到标题（`#`）、块（`#^id`）、文件夹路径
- **Aliases（别名）**：YAML `aliases:` 声明，多个名字指向同一笔记
- **先链接后创建**：链接不存在的笔记会自动创建
- 重命名笔记自动更新全库引用

### 2. 反向链接（Backlinks）— "意外连接"的引擎
- **Linked mentions**：其他笔记显式 `[[链接]]` 指向当前笔记
- **Unlinked mentions**：其他笔记提到同名但未链接 —— 扫描全文嗅出"本可以关联而未关联"的地方
- **"发现意外连接"体验主要来自 Unlinked mentions**

### 3. 知识图谱（Graph view）
- 节点 = 笔记，边 = 内部链接；**被引用越多节点越大**（引用计数可视化）
- **Local Graph（局部图谱）**：只看当前笔记的 N 度邻居，深度可调 —— 解决"图谱太大"的关键
- 分组着色（搜索条件分组）、力导向布局（center/repel/link force）
- 时间推移动画（按创建时间依次出现）
- 过滤：Tags / 附件 / 孤儿笔记（无链接）

## 二、Mira 现有基础（可复用）

| 模块 | 能力 |
|------|------|
| `memory/dynamic-memory.ts` | 记忆图谱管理器：节点/边/社区/激活    传播/衰减 |
| `memory/embedding.ts` + 中文分词/同义词 | 向量嵌入 + 语义关联基础 |
| `ui/memory/graph-data.ts` | 实体/关系提取（正则）+ 图谱数据构建 |
| `ui/memory/MemoryGraph.tsx` | 3D 力导向图谱（react-force-graph-3d） |
| `ui/memory/GraphPanel.tsx` | 全局/项目两级图谱视图 |
| `memory_*` 工具 | 记忆图谱 CRUD（已实现未注册默认） |

## 三、核心启发：Mira 能比 Obsidian 做得更好

Obsidian 的"意外连接"靠**字符串同名匹配**；Mira 已有**向量嵌入 + 同义词 + 激活传播**，
可将"同名发现"升级为**语义发现** —— 找到"意思相近但从未关联"的记忆。这是 Obsidian 做不到的。

## 四、落地启发点

### ① 语义级 Unlinked mentions（最大价值）
- **现状**：`graph-data.ts` 的 `findSimilarPairs` 仅名称相似度；`extractEntities` 是正则匹配
- **目标**：用向量嵌入检索式比对，找出"内容相关但无显式边"的记忆对 → 显示为**虚线"建议边"**，用户确认后固化为真实关系
- **改动**：`memory/dynamic-memory.ts`（新增语义关联检索）+ `ui/memory/graph-data.ts`（建议边标记）

### ② 引用计数 → 节点大小（知识重量可视化）
- **现状**：`GraphNode.size` 按类型固定（memory=6, concept=9/10, project=24）
- **目标**：`size = base + 入度 × 权重`，被关联越多的节点越凸显；叠加激活传播强度
- **改动**：`graph-data.ts`（size 计算）+ `MemoryGraph.tsx`（渲染）

### ③ Local Graph（局部图谱，N 度邻居）
- **现状**：只有全局/项目两级视图，全库节点多时无法聚焦
- **目标**：点击节点 → 只看 1~2 度邻居，深度滑块可调
- **改动**：`MemoryGraph.tsx`（深度过滤 + 交互）

### ④ 悬空链接 → 知识缺口提示
- **现状**：提取出实体但无对应记忆时无提示
- **目标**：渲染为**虚线轮廓悬空节点**，提示"该主题被提到但未沉淀成知识"，引导 Agent/Dream 补全
- **改动**：`graph-data.ts`（悬空节点标记）+ `MemoryGraph.tsx`（样式）

### ⑤ 时间推移动画
- **现状**：无时间叙事
- **目标**：按 `createdAt` 依次出现节点，展示知识演进过程
- **改动**：`MemoryGraph.tsx`

## 五、架构影响

- **不动** Agent 核心循环、LLM 层、事件溯源
- **全部落在** `ui/memory/` + `memory/` 已有模块内扩展
- 工作量排序：②③⑤（小，纯前端）< ④（小）< ①（中，核心增量）

## 六、开发优先级

**第一阶段（MVP 闭环）：①②③** — 分别解决"发现连接""看清重要节点""图谱可用性"
**第二阶段：④⑤** — 知识缺口提示 + 时间叙事
