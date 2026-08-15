# 开发计划：视觉模型选择菜单（composer 内）

- 状态：✅ 已实施（host + client 完成，测试 56 通过 + 1 跳过，tsc 通过，lib 已构建）；**未 commit**——等用户 review diff 后再显式告知 commit
- 关联：dsh-vision-plugin（纯插件，dsh 源码零改动）

## 1. 需求（用户确认版）

1. 菜单只显示**已配置供应商**的免费视觉模型（供应商未在 dsh 配置 → 不显示该供应商；全部未配置 → 菜单不显示）。
2. 免费视觉模型清单**由插件内置提供**（`FREE_VISION_MODELS` 常量，按供应商分组）——**不是**扫描模型目录的 free 字段。
3. 交互：composer 内一个按钮"视觉：<当前模型名>"，点击弹出**下拉/上拉菜单**，按供应商分组展示，选中即切换。
4. 只要配置的供应商里有免费模型，**默认选中一个**（首个可用者）。

## 2. 可行性结论（已调研）

| 点 | 结论 |
|---|---|
| UI 位置 | ✅ `conversation.input.right`（list 席位，模型选择器右侧、发送按钮前——正是用户截图位置）；`conversation.input.left`/`.dock` 为备选 |
| 注册方式 | ✅ 纯插件 `ctx.slots.inject('conversation.input.right', …)`（与 ui-model-selection 注册 `conversation.input.model` 同机制），零源码改动 |
| 数据通道 | ✅ 复用 `ctx.webServer` 路由模式（同 paste 端点）：`GET /vision-plugin/vision-models`、`GET/POST /vision-plugin/vision-model`；client 用 fetch（与粘贴拦截同款零依赖） |
| client 构建 | 方案 A：手写 `client.js` DOM 下拉（零构建，快）；方案 B：clientBundle（需复制 dsh 的 tsdown.client.ts ~300 行 + React 组件 + 类型链，工程大） |
| 免费判断 | 插件内置清单（需求 2 明确），不依赖 dsh 模型元数据 |

## 3. 设计

### 3.1 host 侧

**内置免费视觉模型清单**（`src/vision-models.ts`）——需求 2 的"插件提供的 list"：

```ts
/** 按供应商分组的免费视觉模型清单（插件内置，需人工维护）。 */
export const FREE_VISION_MODELS: Readonly<Record<string, readonly string[]>> = {
  openrouter: [
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-nano-12b-v2-vl:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  ],
  opencode: ['mimo-v2.5-free'],
}
```

**端点**（`src/vision-model-menu.ts`，挂到 `ctx.webServer`，同 paste 模式）：

- `GET /vision-plugin/vision-models` → `{ groups: [{ provider, displayName, models: [{ id, name }] }] }`
  - 只含**已注册供应商**（`ctx.llm.listProviders()` 命中）∩ 清单有模型 ∩ 模型可在该 provider 的 `listModels()` 中解析（目录存在性校验）；
  - 未配置任何供应商 → `{ groups: [] }`（client 不显示菜单）。
- `GET /vision-plugin/vision-model` → 当前选择 `{ provider, model } | null`
- `POST /vision-plugin/vision-model` → 保存选择（校验必须来自清单且供应商已注册）；body `{ provider, model }`

**选择状态**（`src/vision-model-selection.ts`）：进程内可变选择 + 默认规则：
- 默认：按清单顺序取**第一个已注册供应商的第一个可用模型**（需求 4）；
- 选择变化时通知识图服务（`DescribeService` 持有可变的当前视觉路由）。

**识图服务改造**（`src/describe.ts`）：路由解析顺序：
1. 显式配置（`Config.provider` + `Config.models` 已设置）→ 用配置（保持现状，兼容旧用法）；
2. 否则 → 用**当前菜单选择**（`{provider, model}`）+ 同 provider 清单其余模型作回退链；
3. 都没有 → 工具报错"未配置视觉模型供应商"。

### 3.2 client 侧（方案 A：手写 `client.js`，v1 推荐）

- 复用现有 `client.js` 结构（capture 粘贴拦截已存在，追加菜单逻辑）；
- 渲染：在 composer 工具行**注册到 `conversation.input.right` 席位**（`ctx.slots.inject` 注册一个轻组件：返回一个 DOM 容器，手写按钮 + 下拉）；
  - 按钮文案：`视觉：<当前模型名>`（无选择时不显示按钮）；
  - 下拉：绝对定位面板，按供应商分组（组标题 + 模型项），当前选中打勾，点击项 → `POST /vision-plugin/vision-model` → 刷新按钮文案；
  - 数据：挂载时 `GET /vision-plugin/vision-models` + `GET /vision-plugin/vision-model`；`llm/adapters-updated` 后重拉（供应商增删时菜单刷新）；
  - 空列表 → 不渲染按钮。
- 交互细节：点击外部关闭、Esc 关闭、键盘方向键可选（v1 先做鼠标 + Esc）。

> 方案 B（React clientBundle）列为 v2 候选：体验/样式更标准，但需复制 clientBundle 构建链（~300 行）+ slot 类型链 + client 测试，工程量大；v1 先用 A 验证体验。

### 3.3 配置

- 新增 `Config.visionMenu: boolean`（默认 `true`）——开关菜单；关闭时回退到显式配置模式。
- 现有 `Config.provider/models` 语义不变（显式配置优先于菜单选择）。

## 4. 测试计划

- **host 单元**：
  - `vision-models` 清单：已知供应商分组、模型存在性校验（mock llm：已注册/未注册 provider）；
  - 端点：GET 列表（只含已配置供应商）、GET/POST 选择（校验清单来源、非法选择拒绝、未配置返回空）；
  - 默认选择：多个已配置供应商按清单顺序取首个；全部未配置 → null；
  - `DescribeService` 路由解析：显式配置优先；菜单选择 + 回退链；无任何路由 → 报错。
- **client（方案 A 手写 DOM）**：较难做组件级单测（无 React 测试设施）——用**集成验证**（真实实例手测清单）+ 关键逻辑（如"空列表不渲染""分组结构"）抽成可测纯函数放 host 侧导出？v1 以 host 测试 + 手动验证为主。
- **端到端**（手动清单）：配置 openrouter + opencode → 菜单显示两组 → 默认选中首个 → 切换 → describe_image 用新选择识别；移除某供应商 → 菜单刷新。

## 5. 任务清单（实施顺序）

1. `src/vision-models.ts`：清单常量 + 分组解析（已注册供应商 ∩ 清单 ∩ 目录可解析）；
2. `src/vision-model-selection.ts`：选择状态 + 默认规则 + 变化通知；
3. `src/vision-model-menu.ts`：三个 webServer 端点；
4. `src/describe.ts`：路由解析改造（配置 > 菜单选择 > 报错）；
5. `src/config.ts`：`visionMenu` 开关；
6. `client.js`：菜单组件（席位注册 + 按钮 + 分组下拉 + fetch）；
7. host 单元测试 + `tsc` + 现有 36 测试回归；
8. 构建 `lib`；**不 commit**——交用户 diff review；用户确认后再 commit + push。

## 6. 明确不做（v1.1 候选）

- 选择持久化（重启后记住上次选择）——v1 为"默认选中首个"；
- 付费视觉模型入菜单（清单只含免费）；
- 方案 B（React clientBundle）重构；
- 跨 provider 自动回退链（菜单选中模型为主，回退仅限同 provider 清单内）。
