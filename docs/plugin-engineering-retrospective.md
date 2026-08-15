# dsh 自定义插件工程化：从验证 demo 到自包含项目的完整复盘

本复盘基于 `dsh-vision-plugin`（DeepSeek Harness 文本路由识图插件）的真实演进——9 个提交、从手写 demo 到完全自包含的 npm 工程。它既是本项目的心得，也是一份**可复用的方法论**：按"渐进式披露"组织，每个阶段解决一类问题，后一阶段建立在前一阶段之上。

> 适用对象：想给 DeepSeek Harness 写自定义插件的人。dsh 是"一切皆插件"的框架（Cordis 插件体系），官方包私有发布（npm `0.1.0-rc.6`，部分需 token），这是外部插件开发的所有特殊性的根源。

---

## 0. 总览：渐进式披露的五个阶段

| 阶段 | 目标 | 关键产物 | 核心教训 |
|---|---|---|---|
| 1. 验证 demo | 证明"能做" | 手写 JS 插件 + 单端点 | 先跑通，别先工程化 |
| 2. 功能完善 | 覆盖真实场景 | 多模块 + 工具 + 测试 | 一次只解决一个真实问题 |
| 3. TS 化 | 类型安全 | src/ + clientBundle | 浏览器端需独立构建链 |
| 4. 工程收敛 | 可维护、可移植 | 单 tsconfig + 依赖集中 | VSCode 只认 tsconfig.json |
| 5. 自包含 | 脱离宿主仓库 | npm 依赖 + 本地构建 | dsh 包已发布，别猜，去查 |

每一阶段的决策都应在**当时**做最小正确的事，而非预支后续阶段的复杂度。

---

## 阶段 1：验证 demo —— "先证明能做"

### 场景
需求："DeepSeek 官方 API 是纯文本路由，粘贴图片会被拒（MODEL_DOES_NOT_SUPPORT_IMAGES）。能不能让文本模型'看图'？"

### 最小验证
- **手写 lazy-CJS 插件**（`client.js` + `window.__ModuleLoader__.load({id, factory})`），零构建；
- **一个 webServer 端点**：`POST /vision-plugin/paste` 接收图片字节 → 存临时文件 → 返回路径文本插入输入框；
- **一个工具**：`describe_image` 读文件 → 调视觉模型 → 返回描述。

### 关键决策与教训
1. **先跑通主链路，别纠结架构**：demo 阶段验证"paste → 路径 → 工具 → 视觉模型 → 文本"这条链路是否成立即可。当时调研了社区方案（`dsh-vision-router` stealth 路由 vs `modlens` paste-to-path），选了**粘贴转路径**（modlens 路线）——因为它零 hook、零 dsh 源码改动。
2. **纯插件约束**：用户明确"不改 dsh 源码"。这决定了后续所有决策的天花板——只能用公开服务（`ctx.llm`、`ctx.attachments`、`ctx.tools`、`ctx.webServer`、`ctx.slots`）。
3. **手写 client.js 的原因**：方案 A（手写 lazy-CJS）vs 方案 B（React clientBundle）。demo 阶段选 A——零构建、快；**明确记录 B 是后续升级方向**（这个决定后面阶段兑现）。

### 验证方式
- 组合测试（host 侧逻辑）；
- 真实实例手测（粘贴 → 路径 → 描述）。

---

## 阶段 2：功能完善 —— "一次解决一个真实问题"

### 场景
demo 能看图了，但暴露真实问题：
1. 多图消息串行识别 → 卡几分钟；
2. 图片描述不可靠 → 需要复核通道；
3. 粘贴临时文件堆积 → 污染"当前粘贴"的判断。

### 每个提交解决一个真实问题
| 提交 | 问题 | 解法 |
|---|---|---|
| `7afae50` | 多图串行卡顿 | 并发识别（`Promise.allSettled`） |
| `0758a69` | 描述需复核 | `describe_attachment` 工具（按 attachmentId 读存储） |
| `a747163` | 临时文件堆积 | 定期清理 + 选型文档 |

### 关键教训
1. **需求来自真实使用，不是设计想象**：每个功能都是"用户反馈/实测暴露的问题"驱动的。
2. **文档随功能走**：每个行为（临时文件生命周期、选型原则）都有文档承载，不是代码注释堆砌。
3. **测试跟随行为**：并发、超时回退、字节去重都有针对性单测。

---

## 阶段 3：TS 化 —— "浏览器端需要独立构建链"

### 场景
功能稳定后，手写 client.js 的可读性成为瓶颈（用户反馈"语法可读性差"）。决策：迁移到 TypeScript。

### 关键决策：方案 A vs 方案 B
| | 方案 A：手写 JS 重构 | 方案 B：React clientBundle |
|---|---|---|
| 构建 | 零构建 | 需 clientBundle 构建链 |
| 可读性 | 有限提升 | 大幅提升（JSX + 类型） |
| 成本 | 低 | 高（复制构建链 + 类型链） |

**实际选择：B**（用户拍板）。理由：既然要 TS 化，就彻底——React 组件 + CSS Modules + 类型链。

### 落地内容（`1924bcd`）
- `src/client/`：`index.ts`（apply/inject/slots）、`paste.ts`、`fetch.ts`、`VisionModelMenu.tsx`、`VisionMenu.module.css`；
- 复用 harness 的 `clientBundle` 预设（`import { clientBundle } from '../../deepseek-harness/...'`）；
- `tsconfig.client.json` 独立 client 面类型链。

### 踩坑
1. **VSCode 只自动发现 `tsconfig.json`**（`findDefaultConfiguredProjectWorker` 只查这两个文件名）——`tsconfig.client.json` 永远不会被 TS server 自动发现。src/client 落入无 paths 的 inferred project → ts(2307)。**解法：合并为单一 tsconfig.json**（阶段 4 处理，但这里埋下伏笔）。
2. **CSS Modules 需要构建插件**：clientBundle 预设内置 lightningcss 虚拟插件，注入 `<style data-plugin>` 标签。

---

## 阶段 4：工程收敛 —— "VSCode 只认 tsconfig.json"

### 场景
ts(2307) 报错（CLI 绿、编辑器红）暴露类型链分裂问题。

### 根因（查 TS server 源码确认）
`findDefaultConfiguredProjectWorker` **每层目录只查 `tsconfig.json` / `jsconfig.json`**。双 tsconfig 拆分 → src/client 无归属 project。

### 解决（`6e4ae35`）
- **合并为单一 tsconfig.json**：extends base.client（JSX + DOM lib）+ node types + 合并 paths；
- 删除 tsconfig.client.json；
- 单一 project 覆盖全部源码，编辑器与 CLI 一致。

### 关键教训
1. **CLI 绿 ≠ 编辑器绿**：`tsc -p tsconfig.client.json` 能过，但 VSCode 用的是另一个 project。**用 TS server 的实际发现逻辑验证**，不是只看 tsc 退出码。
2. **一个包一个 tsconfig.json** 是 dsh 生态惯例（官方 client 包都这样）。

---

## 阶段 5：自包含 —— "dsh 包已发布，别猜，去查"

### 场景
tsconfig paths 里 44 项 `../../deepseek-harness/...` 相对路径——换机器/换目录就断。用户问："能不能去掉这些项目外依赖？"

### 关键转折：调研发现真相
1. **社区高星插件**（`dsh-TUI` 1125★）用**纯 npm 版本号依赖**（`"@deepseek-ai/dsh-llm": "^0.1.0-rc.6"`）；
2. **`@deepseek-ai/*` 已发布到 npm**（`0.1.0-rc.6` 比本地源码 rc.5 还新）——之前"未发布"是**过时假设**（visual-plugin bootstrap.sh 里写的是早期 rc.1 的旧结论）；
3. **有 client 端的插件**（`dsh-visual-plugin`）把 harness 的 clientBundle 预设 **vendor 进自己仓库**——这是"有浏览器端插件"的标准自包含解法。

### 决策链
1. **先查证**：用 gh api 查 npm registry 确认 `dsh-llm` 等 10 个包都有 rc.6（不是 npm view，那个被沙箱拦）；
2. **pnpm install 到插件自己的 node_modules**（关键：先解除 harness junction，否则 pnpm 会把 harness node_modules 当目标重建——**上次事故的教训**）；
3. **tsconfig 完全自包含**（删 extends harness + 44 项 paths，标准 node_modules 解析）；
4. **tsdown standalone**（`2812bce`）：vendor clientBundle 预设为本地配置（~150 行，含 CSS Modules 插件），零 harness import。

### 踩坑记录
1. **pnpm install 破坏 harness node_modules**：插件 node_modules 是 harness junction，pnpm 误当 harness 重建。恢复：`pnpm install --offline --ignore-scripts` 在 harness 根重建（.pnpm 存储完好）。
2. **npm 版类型拖入 harness 源码**：tsconfig extends base.client 会带入它的 paths（指向 harness src）→ 显式 `"paths": {}` 清空 / 最终自包含。
3. **vitest 的 standardDecoratorPlugin 冗余**：实测去掉后 61 测试全绿（现代 Vite 原生支持标准 decorators）——**别信"需要"的假设，实测**。

---

## 可复用方法论：dsh 插件工程化清单

### 立项
- [ ] 明确约束（改不改 dsh 源码？用哪些公开服务？）
- [ ] 调研社区方案（awesome-dsh-plugin、高星插件做法）
- [ ] 确认 dsh 包在 npm 的可安装性（**别猜，查 registry**）

### Demo → 工程
- [ ] 先手写最小插件跑通主链路（`window.__ModuleLoader__.load`）
- [ ] 单端点 + 单工具验证核心价值
- [ ] 记录方案 A/B 取舍，明确升级路径

### 功能完善
- [ ] 每个真实问题一个提交，测试跟随
- [ ] 行为写文档（不写进代码注释）

### TS 化
- [ ] 一个包一个 tsconfig.json（VSCode 只认这个）
- [ ] client 端用 clientBundle 预设（或 vendor 本地）
- [ ] CSS Modules 走构建插件（lightningcss）

### 自包含
- [ ] devDeps 用 npm 版本号（`^0.1.0-rc.6`）
- [ ] 独立 node_modules（**先解除 harness junction 再 pnpm install**）
- [ ] tsconfig 零 harness extends
- [ ] tsdown standalone（vendor 预设，同 dsh-visual-plugin）
- [ ] pnpm-lock.yaml 入库

### 验证
- [ ] tsc + vitest + tsdown 全部用插件本地工具
- [ ] 全仓库 grep `../../deepseek-harness` 应只剩 docs 历史
- [ ] 重启 dsh web 实测（刷新只拉 bundle，重启最稳）

---

## 附录：关键事实速查

- dsh 插件加载：`dsh plugin --profile web add <path>` → profile node_modules Junction 指向源码；运行时 `@deepseek-ai/*` 从 dsh 安装解析。
- 浏览器端协议：`window.__ModuleLoader__.load({id, factory})`，react 等由浏览器模块表提供（external）。
- npm 版本：`@deepseek-ai/*` 现为 `0.1.0-rc.6`；框架（cordis/schemastery/cosmokit）为 `rc.4`。
- VSCode TS server 只发现 `tsconfig.json`/`jsconfig.json`。
- `pnpm install` 在 junction node_modules 上会误重建目标目录——先解除。
