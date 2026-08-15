---
name: dsh-plugin-engineering
description: >
  为 DeepSeek Harness 开发自定义插件时使用。本 skill 渐进式披露 dsh 外部插件的工程化
  路径：从手写验证 demo 起步，逐步演进到完全自包含的 npm 工程。覆盖每个阶段的形态选择、
  构建链决策、依赖处理与踩坑——基于 dsh-vision-plugin 的真实演进（9 提交，demo → 自包含）。
  到达成人阶段时按需阅读对应 reference，不预支后续阶段复杂度。
license: MIT
metadata:
  author: youlicc/dsh-vision-plugin
  version: "1.0.0"
---

# dsh 自定义插件工程化（渐进式披露）

本 skill 把 dsh 外部插件开发组织成**五个渐进阶段**：每个阶段解决一类问题，后一阶段建立在前一阶段之上。核心原则：**先证明能做，再工程化**；**别猜，去查**（npm 发布状态、工具行为都要实测）。

## 何时使用

- 用户想为 dsh 开发新插件（工具 / skill 包 / MCP / 浏览器 UI / 组合层）；
- 已有 demo 想升级为正规工程（TS 化、自包含、可移植）；
- 插件报错且原因涉及构建链、依赖解析、VSCode 类型。

## Step 0：明确约束与调研（一切决策的天花板）

1. **约束**：改不改 dsh 源码？能用哪些公开服务？这决定后续所有取舍。
   - 纯插件 = 只用 `ctx.llm` / `ctx.attachments` / `ctx.tools` / `ctx.webServer` / `ctx.slots`。
2. **调研社区**：awesome-dsh-plugin 高星插件怎么处理依赖？有 client 端的 vs 纯 host 的解法不同。
3. **确认 npm 可安装性**：**别猜，查 registry**（`gh api https://registry.npmjs.org/@deepseek-ai/dsh-llm --jq '.versions|keys|.[-1]'`）。曾误判"未发布"，实际 `0.1.0-rc.6` 已公开。

→ 完成形态选型：纯 skill / MCP / Node 工具 / Node+浏览器 UI。**有浏览器端是分水岭**：它需要 clientBundle 构建链。

## Step 1：验证 demo（手写最小插件）

**目标**：跑通主链路，证明价值。**不要**一上来就工程化。

- 手写 lazy-CJS：`window.__ModuleLoader__.load({id, factory})`，零构建；
- 一个 webServer 端点 + 一个工具，验证核心场景；
- 明确记录方案 A（手写）/ B（React clientBundle）取舍，B 是升级方向。

## Step 2：功能完善（一次一个真实问题）

- 每个提交解决一个**真实使用暴露**的问题（并发卡顿、复核通道、资源清理）；
- 测试跟随行为（并发、超时、去重各有单测）；
- 行为写文档，不写进代码注释。

## Step 3：TS 化（有浏览器端时）

- 有 client 端 → React + CSS Modules + clientBundle 预设（或 vendor 本地）；
- **一个包一个 tsconfig.json**（VSCode 只自动发现它——`tsconfig.client.json` 永远不会被发现，src/client 会落入无 paths 的 inferred project 报 ts(2307)）；
- 合并 host+client 为单一 tsconfig：extends base.client + node types。

## Step 4：工程收敛（类型链与依赖集中）

- CLI 绿 ≠ 编辑器绿：用 **TS server 的实际发现逻辑**验证，不是只看 tsc 退出码；
- 依赖路径集中（如 `harness.paths.json` 单点），换机器只改一处；
- vitest 的"必需"插件要实测（standardDecoratorPlugin 实测冗余，删）。

## Step 5：自包含（脱离宿主仓库）

1. **查证 npm**：devDeps 用版本号（`^0.1.0-rc.6`）；
2. **独立 node_modules**：⚠️ 先解除插件 node_modules 的 harness junction，再 `pnpm install`（junction 会被 pnpm 误当目标重建，破坏 harness——恢复：harness 根 `pnpm install --offline --ignore-scripts`）；
3. **tsconfig 完全自包含**（删 harness extends + paths，标准 node_modules 解析；若 extends 会带入 harness paths 则显式 `"paths": {}` 清空）；
4. **构建 standalone**：有 client 端时，把 harness 的 `clientBundle` 预设 vendor 进插件为本地配置（同 dsh-visual-plugin 做法，~150 行，含 CSS Modules 虚拟插件）；
5. pnpm-lock.yaml 入库。

## 验证清单

- [ ] tsc + vitest + tsdown 全部用插件本地工具（node_modules/.bin）
- [ ] 全仓库 grep `../../deepseek-harness` 应只剩 docs 历史
- [ ] 重启 dsh web 实测（刷新拉 bundle，重启最稳）
- [ ] README 的 Development 段准确反映当前依赖状态

## References

- `references/gotchas.md` —— 踩坑速查（junction 事故、tsconfig 发现、npm 误判等）
- `references/checklist.md` —— 各阶段可勾选清单
- 项目复盘全文：`../../docs/plugin-engineering-retrospective.md`
