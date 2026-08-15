# 实施计划：client.js → TS + clientBundle（方案 B）

- 状态：待评审
- 目标：把 `vision-plugin/client.js`（手写 lazy-CJS）迁移为 TypeScript + React 组件，经 dsh 的 clientBundle 构建链产出 `lib/client.js`，与 dsh 官方 client 插件同构。
- 功能不变：粘贴拦截 + 视觉模型菜单，行为、端点、样式语义全部保持。

## 1. 目标结构（对齐 dsh client 插件规范）

```
vision-plugin/
  src/
    index.ts                    # host 入口（不变）
    ...（host 各模块不变）
    client/
      index.ts                  # browser 入口：apply + inject（替代 client.js 的插件体）
      VisionModelMenu.tsx       # 菜单组件（React，替代手写 createElement）
      VisionMenu.module.css     # 菜单样式（CSS Modules，替代 MENU_CSS 内联注入）
      paste.ts                  # 粘贴拦截（capture 监听 + verdict 缓存）
      fetch.ts                  # fetchJson/routeLabel 等纯工具
  lib/
    index.js                    # host 产物（tsdown，不变）
    client.js                   # browser 产物（clientBundle 生成，新）
    types/client/index.d.ts     # client 类型（tsc 生成，新）
  tests/
    vision-menu.client.spec.tsx # client 组件测试（新，jsdom）
  tsconfig.json                 # host 面（不变）
  tsconfig.client.json          # client 面（新增，extends tsconfig.base.client.json）
  tsdown.config.ts              # 改为 clientBundle()（双面构建）
  package.json                  # exports "./client" → "./lib/client.js"，加 dsh.client 声明
```

## 2. 实施步骤

### 2.1 构建链
1. `tsdown.config.ts` → 使用 dsh 的 `clientBundle` 预设：从 harness 绝对路径 import（`../../deepseek-harness/packages/client/tsdown.client.ts`），lib 入口 `['lib/types/index.js', 'lib/types/client/index.js']`，id = `@dsh-external/dsh-vision-plugin`。产物 `lib/client.js`（banner/footer 自动包 lazy-CJS）。
2. 验证 `clientBundle` 内部 `./web/src/platform.ts` 相对导入在外部仓库 cwd 下可解析（tsdown 以配置文件所在目录解析相对导入，应无碍；如有问题则改为在本地复制精简版预设，仅保留本插件需要的 CSS modules + external 逻辑）。
3. `package.json`：`exports["./client"]` → `./lib/client.js`；新增 `dsh.client = { platform: 'web', immediately: true, inject: ['@deepseek-ai/dsh-client-ui-conversation'] }`（对齐 dsh 规范；`inject` 仅信息性）。
4. `tsconfig.client.json`：extends `deepseek-harness/tsconfig.base.client.json`，references 指向 harness 的 client 包（ui-conversation、ui-slots、runtime 等）。

### 2.2 源码迁移（行为等价）
5. `src/client/paste.ts`：原样搬移粘贴拦截逻辑（`imageFilesOf`/`insertText`/`uploadOne`/verdict 缓存/监听安装），TS 化（类型化 event、明确返回 disposer）。
6. `src/client/fetch.ts`：`fetchJson`、`routeLabel` 纯函数 + 类型。
7. `src/client/VisionModelMenu.tsx`：React 组件——state（open/loading/error/groups/current）、挂载/打开时 load、外点/Esc 关闭、分组渲染、选中态样式、POST 切换。用 JSX 替换 `React.createElement` 嵌套。
8. `src/client/VisionMenu.module.css`：把 MENU_CSS（trigger/option/selected/hover）搬进 CSS Modules，按 dsh token 规范（`--dsw-*`）写。皮肤覆盖能力保留：类选择器 + 无内联 font 属性（与现在一致）。
9. `src/client/index.ts`：`export const inject = ['slots']`；`apply(ctx)` 注册 `conversation.input.right`（`ctx.slots.inject`）+ 安装粘贴监听 + `ctx.effect` 清理。与现在 client.js 的 apply 完全等价。

### 2.3 类型链
10. `src/client/index.ts` 顶部 type-only import：`@deepseek-ai/dsh-client-runtime/client`（ClientContext）、`@deepseek-ai/dsh-client-ui-conversation/client`（SlotMap merge，type-only 拉取 `conversation.input.right` 声明）。
11. 组件 props 走 slot 标准四件套（PropsRuntime/PropsRenderSlots/PropsStore/inject face）——本插件用不到 owner/inject 业务数据，组件可声明为无 props 依赖或最小 props。

### 2.4 测试
12. `tests/vision-menu.client.spec.tsx`：jsdom 组件测试——渲染按钮、打开/关闭、分组渲染、选中勾选、POST 调用（mock fetch）、空组隐藏；另保留一个 host 面回归（apply 不抛）。
13. 现有 host 测试全部保持通过；`vitest.config.ts` 增加 client spec 的 jsdom 环境（per-file pragma）。

### 2.5 构建与验证
14. 双面构建：`tsdown --env.DSH_BUILD_FACE=host` + `=client`（或默认双面），确认 `lib/index.js` 与 `lib/client.js` 都产出。
15. `tsc --noEmit` 双面通过；`node --check` 产物；全部 vitest 通过。
16. 手动验证：浏览器 Ctrl+F5，粘贴 + 菜单行为与迁移前一致。

## 3. 风险与对策
| 风险 | 对策 |
|---|---|
| clientBundle 预设相对导入在外部仓库不可用 | 备选：本地复制精简预设（仅 external + CSS modules），约 120 行 |
| client 类型链（references）在仓库外难以组装 | tsconfig.client.json 用 harness 的 paths 映射（同现有 tsconfig.json 手法）替代 project references |
| CSS Modules 需 lightningcss | harness node_modules 已含（1.32.0），tsdown 自动内联 |
| 皮肤（maid-atelier）字体覆盖能力丢失 | 迁移后类名从 `dsh-vision-trigger` 变 CSS module hash，需保留选择器形态或加 `:global` 兼容层 |

## 4. 明确不做（本次）
- 不改 host 侧（src/*.ts 全部不动）。
- 不改行为/端点/样式语义。
- 不做 client 到 dsh 仓库的回归（dsh 零改动）。

## 5. 交付
- 迁移后 `client.js` 从包根删除（被 `src/client/` + `lib/client.js` 取代）。
- README 更新（构建说明：双面 tsdown）。
- 全部测试 + 构建通过后交用户 review；不 commit（等显式指示）。
