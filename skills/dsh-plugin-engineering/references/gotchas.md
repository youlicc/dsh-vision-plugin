# dsh 插件开发踩坑速查

领域特定事实，违反合理假设——每条都是 dsh-vision-plugin 实测踩过并修复的。

## 1. npm 发布状态：别猜，去查

- `@deepseek-ai/*` 已发布到 npm，`0.1.0-rc.6`（框架 cordis/schemastery/cosmokit 为 `rc.4`）。
- 曾误判"未发布"（引用了 visual-plugin bootstrap.sh 里早期 rc.1 的旧结论）。**验证方法**：
  ```sh
  gh api https://registry.npmjs.org/@deepseek-ai/dsh-llm --jq '.versions | keys | .[-1]'
  ```
  （沙箱里 `npm view` 可能被拦，gh api 能通。）
- 个别包可能缺（如 `dsh-type-meta` 404）——但**不是**"全部未发布"，逐包查。

## 2. VSCode TS server 只发现 `tsconfig.json` / `jsconfig.json`

- `findDefaultConfiguredProjectWorker` 每层目录只查这两个文件名。
- `tsconfig.client.json` 永远不会被自动发现 → src/client 落入无 paths 的 inferred project → ts(2307)。
- **解法**：一个包一个 tsconfig.json（合并 host + client）。
- **验证**：`tsc -p tsconfig.json` 绿 ≠ VSCode 绿。用 TS server 实际逻辑推演，别只看 tsc 退出码。

## 3. extends 会带入 harness 的 paths

- `extends ../../deepseek-harness/tsconfig.base.client.json` 会把它的 `paths`（指向 harness src）带进你的 tsconfig。
- npm 包类型解析被 paths 劫持到 harness 源码 → 一堆"harness src 编译错误"。
- **解法**：完全自包含 tsconfig（不 extends），或显式 `"paths": {}` 清空。

## 4. pnpm install 在 junction node_modules 上会误重建目标目录

- 插件 node_modules 若是指向 harness 根 node_modules 的 junction，`pnpm install` 会把它当 harness 重建 → **破坏 harness**。
- **解法**：先 `cmd /c rmdir <junction>`（只删链接），再 pnpm install 到独立目录。
- **恢复**：harness 根 `pnpm install --offline --ignore-scripts`（.pnpm 虚拟存储完好则秒级重建）。

## 5. vitest 的"必需"插件可能冗余

- harness 的 `standardDecoratorPlugin`（处理标准 TS decorators）——**实测去掉后 61 测试全绿**（现代 Vite/oxc 原生支持）。
- **原则**：别信"需要"的假设，删除后跑一遍测试。

## 6. 有 client 端才有 clientBundle 需求

- 纯 host 插件（如 dsh-TUI）：`tsc` 就够，无 clientBundle。
- 有浏览器端（React/CSS Modules/lazy-CJS）：需要 clientBundle 构建。
- harness 的 `packages/client/tsdown.client.ts` 是**仓库级脚本**（不在 npm 发布物），要自包含需 vendor 本地（同 dsh-visual-plugin）。

## 7. 浏览器端协议

- 产物必须是 `window.__ModuleLoader__.load({id, factory})` 格式（lazy-CJS）。
- react 等平台模块 external（运行时由浏览器模块表提供），**不打包**。
- CSS Modules 由构建插件内联（lightningcss），注入 `<style data-plugin>` 标签。

## 8. 运行时 vs 开发期依赖是两回事

- 运行时：`@deepseek-ai/*` 从 dsh 安装解析（profile node_modules），与插件仓库位置无关。
- 开发期：npm 依赖装进插件自己 node_modules 后，也不再依赖 harness。
- **验证**：全仓库 grep `../../deepseek-harness` 应只剩 docs 历史记录。
