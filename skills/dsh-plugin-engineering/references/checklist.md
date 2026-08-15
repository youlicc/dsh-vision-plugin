# dsh 插件工程化：阶段检查清单

按渐进阶段逐项勾选。每阶段完成后再进下一阶段，不预支复杂度。

## 阶段 0：约束与调研
- [ ] 明确约束：改不改 dsh 源码？用哪些公开服务（ctx.llm / attachments / tools / webServer / slots）？
- [ ] 调研社区：awesome-dsh-plugin 高星插件；同形态（有无 client 端）的参照
- [ ] 查 registry：`gh api .../npmjs.org/@deepseek-ai/dsh-llm --jq '.versions|keys|.[-1]'` 确认可装
- [ ] 形态选型：纯 skill / MCP / Node 工具 / Node+浏览器 UI（有浏览器端 = 需要 clientBundle）

## 阶段 1：验证 demo
- [ ] 手写 lazy-CJS（`window.__ModuleLoader__.load`），零构建
- [ ] 一个 webServer 端点 + 一个工具，跑通主链路
- [ ] 记录方案 A/B 取舍，明确升级方向

## 阶段 2：功能完善
- [ ] 每个真实问题一个提交，测试跟随
- [ ] 行为写文档（临时文件生命周期、选型原则等）
- [ ] 并发/超时/去重等边界有单测

## 阶段 3：TS 化
- [ ] host 侧 src/*.ts
- [ ] 有 client 端：src/client/*.tsx + CSS Modules + clientBundle
- [ ] 单一 tsconfig.json（不拆 client tsconfig——VSCode 只认它）
- [ ] tsc + vitest 绿

## 阶段 4：工程收敛
- [ ] tsconfig 不 extends harness（或 paths 显式清空）
- [ ] 依赖路径集中（单点可改）
- [ ] vitest "必需"插件实测（删除后跑一遍）
- [ ] CLI 与编辑器（VSCode）都绿

## 阶段 5：自包含
- [ ] devDeps 用 npm 版本号（`^0.1.0-rc.6`）
- [ ] ⚠️ 先解除 node_modules 的 harness junction，再 pnpm install
- [ ] tsconfig 完全自包含（标准 node_modules 解析）
- [ ] clientBundle 预设 vendor 本地（有 client 端时）
- [ ] pnpm-lock.yaml 入库
- [ ] 全仓库 grep `../../deepseek-harness` 只剩 docs 历史

## 最终验证
- [ ] tsc / vitest / tsdown 全用插件本地工具
- [ ] 重启 dsh web 实测（粘贴 + 核心功能）
- [ ] README Development 段准确
