# dsh-vision-plugin

**让 DeepSeek 官方（纯文本）模型也能"看图"的视觉桥接插件。**

粘贴图片不再被拒绝——图片内容变成文本描述进入上下文，全程一个会话、一个主模型。**纯插件实现，不修改 dsh 源码。**

## 目录

- [设计目标](#设计目标)
- [工作原理](#工作原理)
- [特性](#特性)
- [安装](#安装)
- [配置](#配置)
- [使用](#使用)
- [项目结构](#项目结构)
- [验证](#验证)
- [与社区方案的关系](#与社区方案的关系)
- [开发](#开发)

---

## 设计目标

**解决的痛点**：DeepSeek 官方 API 是纯文本路由，粘贴图片会被直接拒绝（`MODEL_DOES_NOT_SUPPORT_IMAGES`）。用户只能手动切换会话和视觉模型、识别完再搬回文本会话——极其繁琐。

**本插件一次解决**：

- 粘贴图片 → 自动转成文本描述 → 进入上下文
- 全程**一个会话、一个主模型**，无需手动切换
- **纯插件实现**，不修改任何 dsh 源码

**明确不做的事**：

- 不改 DeepSeek 适配器
- 不改 agent 循环
- 不引入子 agent
- 不做路由接管（对比社区 stealth 方案，见[下文](#与社区方案的关系)）

---

## 工作原理

**核心机制：paste-to-path**（借鉴社区 `modlens` 方案）。

```
浏览器粘贴图片
    │
    ▼
粘贴事件被拦截（浏览端抢先处理）
    │
    ▼
字节上传到插件 webServer 端点（POST /vision-plugin/paste）
    │
    ▼
落成私有临时文件
    │
    ▼
文件路径以纯文本插入输入框
    │
    ▼
发送后 agent 自动调用 describe_image 工具
    │
    ▼
插件用可配置视觉模型识别 → 描述文本返回上下文
```

关键点：**图片从不进入 prompt**，文本路由的准入无从拒绝。DeepSeek 看到的是路径文本，主动调用 `describe_image` 工具，视觉调用通过 `ctx.llm` 直连——供应商无关，provider/model 全配置化。

图片只存在于磁盘临时文件与附件存储，模型可见内容全是文本——不触碰 host 准入、agent 循环与日志不变量。

---

## 特性

| 特性 | 说明 |
|---|---|
| 🖼️ **粘贴识图** | Ctrl+V 粘贴图片 → 自动生成文本描述进入上下文 |
| 🧭 **视觉模型菜单** | composer 工具行"视觉：\<模型\>"按钮，按供应商分组下拉切换 |
| ⚡ **免费模型优先** | 只显示**已配置供应商**的**免费**视觉模型，默认选中清单第一个可用者 |
| 🔗 **供应商无关** | 视觉调用走 `ctx.llm` 通用 seam，provider/model 全配置化 |
| 🧹 **自动清理** | 粘贴临时文件超过保留期自动删除，不堆积 TEMP |
| 🚫 **零侵入** | 纯插件，dsh 源码零改动 |

---

## 安装

```sh
# 在 deepseek-harness 仓库根执行
pnpm dsh plugin --profile web add /path/to/dsh-vision-plugin/vision-plugin
# 重启 dsh web 服务
```

安装后**默认配置即开即用**：不配置 `provider`/`models` 时，由 composer 菜单选择免费视觉模型。

---

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `provider` | 缺省 | 视觉模型路由（任何已注册 llm 路由）；与 `models` 同时缺省时用菜单选择 |
| `models` | 缺省 | 有序回退链；与 `provider` 同时缺省时用菜单选择（同供应商免费模型作回退） |
| `visionMenu` | `true` | 是否启用 composer 视觉模型菜单（关掉后只走显式配置） |
| `systemPrompt` | 中文识图提示词 | 视觉调用系统提示 |
| `pasteToPath` | `true` | 是否启用浏览器粘贴拦截（`false` 则恢复原生粘贴行为，只用工具） |
| `pasteMaxBytes` | 20MB | 粘贴上传字节上限 |
| `maxOutputTokens` / `timeoutMs` / `maxInputBytes` | 2048 / 60000 / 0 | 视觉调用参数 |

---

## 使用

**0. （可选）选择视觉模型**

composer 工具行右侧的"视觉：\<模型\>"按钮 → 按供应商分组的免费模型下拉 → 点击切换。默认已选中清单第一个可用者；无可用时不显示按钮。

**1. 粘贴图片（主路径）**

在 DeepSeek 会话 Ctrl+V 粘贴 → 输入框出现图片的**临时文件路径** → 发送 → agent 自动调用 `describe_image` → 描述进入上下文（5–30 秒）。

**2. 本地图片**

对 agent 说"用 describe_image 看一下 `<路径>`"。

**3. 视觉模型会话**

粘贴走原生缩略图路径（客户端先询问 host 的 verdict，只有确认为文本模型才接管粘贴）。

### 粘贴临时文件：机制与清理

- **存放位置**：系统临时目录的私有目录 `dsh-vision-paste-<随机>/paste-<时间戳>.<扩展名>`（0600 权限）
- **自动清理**：超过 `pasteRetentionMs`（默认 24 小时）的目录在**插件挂载时和每次新粘贴后**自动删除——不会在 TEMP 里长期堆积
- **选型原则**：消息里自带路径文本时直接使用（paste-to-path）；包装模型（缩略图）路径下消息没有路径，一般取**最新的** `dsh-vision-paste-*` 目录，**最准确**是取创建时间最贴近消息发出时间的目录

> **已知限制（v1）**：粘贴的图片在消息里显示为路径文本而非缩略图；免费模型有频率限制（约 20 请求/分钟）；菜单选择不持久化（刷新回默认）。

---

## 项目结构

```
dsh-vision-plugin/
├── docs/
│   ├── vision-lazy-design.md              # 完整设计文档（A 式→B 式演进记录）
│   ├── development-plan-vision-menu.md    # 视觉模型菜单实施计划（已实施）
│   ├── migration-plan-client-ts.md        # client 迁移 TS + clientBundle 计划（已实施）
│   ├── plugin-engineering-retrospective.md # 插件工程化复盘（demo → 自包含）
│   └── development-workflow.md            # 分支 / PR / 合并工作流
└── vision-plugin/                         # 插件包 @dsh-external/dsh-vision-plugin
    ├── src/                               # host 侧：paste 端点 + 识图服务 + describe_image 工具 + 视觉模型菜单端点
    ├── src/client/                        # browser 侧：React 组件 + 粘贴拦截（TS）
    ├── tests/                             # host 单测 + client 组件测试（62 用例）
    ├── lib/                               # 构建产物：index.js（host）+ client.js（browser bundle）
    └── cordis.patch.yml                   # bundle 注册
```

> 配套的通用技能 `dsh-plugin-engineering`（渐进式披露的插件工程化指南）位于开发环境技能目录：`<dev-root>/.agents/skills/dsh-plugin-engineering/`（本仓库之外的共享位置，供所有 dsh 插件开发使用）。

---

## 验证

- **插件**：`vitest run`（62 用例：61 通过 + 1 Windows 跳过）+ 双面 `tsc --noEmit`（host + client）+ `tsdown` 双面构建全绿
- **dsh**：零改动，无需回归
- **端到端**：早期 A 式版本已在真实实例验证三条路径；B 式核心链路（工具识别 + 临时文件读取）由组合测试覆盖，粘贴拦截与视觉模型菜单待真实实例复验

---

## 与社区方案的关系

本插件与 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 中的视觉插件目标相同，实现取舍不同：

| 方案 | 机制 | 取舍 |
|---|---|---|
| `dsh-vision-router` | stealth 路由接管 + adapter 层改写 | 图片保留缩略图，但机制复杂（单文件 130KB+），重写模型选择语义 |
| `liustack/modlens` | **paste-to-path**（粘贴转路径）+ 工具 | 轻（33KB + 8KB 客户端）、零 hook，但粘贴显示为路径 |
| **本插件** | **paste-to-path + `ctx.llm` 直连 + 免费模型回退链** | 与 modlens 同路线；视觉通道走已配置的 OpenRouter 路由（免本地 OCR 引擎），回退链保证可用性 |

**可借鉴的后续项**：描述缓存回填、`registerConfigurableProviders` 配置面（设置页可视配置）、像素级工具链（crop/OCR/grounding）。

---

## 开发

本仓库遵循 **feature 分支 → PR → squash merge** 流程：master 受 GitHub ruleset 保护（强制 PR、禁 force push、禁删除），日常开发在独立分支进行，合入时 squash 为单个 commit。完整流程与命令见 [`docs/development-workflow.md`](docs/development-workflow.md)。

**开发本插件仓库**：所有 `@deepseek-ai/*` 包、react 与工具链（typescript/vitest/tsdown/lightningcss）都通过 npm 从本包自己的 `node_modules` 解析（`^0.1.0-rc.6`），执行 `pnpm install` 即可，**完全不需要 harness 检出**。`tsdown.config.ts` 是本地 standalone 双面构建（host + client）。详见 `vision-plugin/README.md` 的 "Development" 一节。
