# dsh-vision-plugin

**让 DeepSeek 官方（纯文本）模型也能"看图"的视觉桥接插件**：粘贴图片自动转为文本描述进入上下文，全程一个会话、一个主模型。纯插件实现，不修改 dsh 源码。

## 架构

```
浏览器 (client)                          host (plugin)
───────────────────────                 ─────────────────────
粘贴事件拦截 ──字节──▶ POST /vision-plugin/paste ──▶ 私有临时文件
        │                                        │
        └── 文件路径以纯文本插入输入框 ◀──────────┘
                 │
发送 ──▶ agent 调用 describe_image 工具
                 │
                 └──▶ DescribeService ── ctx.llm ──▶ 视觉模型 ──▶ 描述文本进上下文
```

核心设计：

- **paste-to-path**：浏览端在粘贴事件上抢先拦截图片，字节上传到插件 webServer 端点（`POST /vision-plugin/paste`），落成私有临时文件，**文件路径以纯文本插入输入框**。图片从不进入 prompt，文本路由的准入无从拒绝。
- **工具触发**：模型看到路径文本后调用 `describe_image` / `describe_attachment` 工具，插件读取临时文件或附件，用视觉模型识别后把描述文本返回。
- **供应商无关**：视觉调用通过 `ctx.llm` 通用 seam 直连，provider/model 全配置化；同一图片字节并发请求共享一次识别（in-flight 去重）。
- **零侵入**：只用 dsh 公开服务（`ctx.llm`、`ctx.attachments`、`ctx.tools`、`ctx.webServer`、`ctx.slots`），不触碰 host 准入、agent 循环、日志不变量。

## 模块

```
vision-plugin/                        # 插件包 @dsh-external/dsh-vision-plugin
├── src/                              # host 侧
│   ├── index.ts                      # 入口：注册工具、paste 端点、菜单、wrapped providers
│   ├── config.ts                     # 配置 schema
│   ├── describe.ts                   # DescribeService：供应商无关识图桥（ctx.llm 直连 + 去重）
│   ├── describe-image.ts             # describe_image 工具
│   ├── describe-attachment.ts        # describe_attachment 工具
│   ├── attachment-reader.ts          # 附件/临时文件读取
│   ├── paste.ts                      # POST /vision-plugin/paste 端点
│   ├── vision-models.ts              # FREE_VISION_MODELS 免费视觉模型清单 + 路由解析
│   ├── vision-model-selection.ts     # 菜单选择状态
│   ├── vision-model-menu.ts          # composer 视觉模型菜单端点
│   ├── wrapped-provider.ts           # (vision) 镜像模型包装
│   └── client/                       # browser 侧（React + TS，独立 clientBundle 构建）
│       ├── index.ts                  # 注入菜单 + 粘贴拦截
│       ├── paste.ts                  # 粘贴事件拦截
│       ├── fetch.ts                  # host 端点调用
│       └── VisionModelMenu.tsx       # "视觉：<模型>" 按钮 + 分组下拉
├── tests/                            # host 单测 + client 组件测试（62 用例）
├── lib/                              # 构建产物：index.js（host）+ client.js（browser bundle）
└── cordis.patch.yml                  # bundle 注册
```

## 安装

```sh
# 在 deepseek-harness 仓库根执行
pnpm dsh plugin --profile web add /path/to/dsh-vision-plugin/vision-plugin
# 重启 dsh web 服务
```

默认配置即开即用：不配置 `provider`/`models` 时，由 composer 菜单选择免费视觉模型。

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

## 使用

1. **（可选）选择视觉模型**：composer 工具行"视觉：\<模型\>"按钮 → 按供应商分组的免费模型下拉 → 点击切换。菜单只显示**已配置供应商**的**免费**视觉模型（插件内置 `FREE_VISION_MODELS` 清单，不扫描元数据），默认选中清单顺序第一个；无可用免费模型时按钮隐藏。
2. **粘贴图片**：DeepSeek 会话 Ctrl+V 粘贴 → 输入框出现图片的**临时文件路径** → 发送 → agent 自动调用 `describe_image` → 描述进入上下文（5–30 秒）。
3. **本地图片**：对 agent 说"用 describe_image 看一下 `<路径>`"。

粘贴临时文件存放在系统临时目录的私有目录 `dsh-vision-paste-<随机>/`（0600 权限），超过 `pasteRetentionMs`（默认 24 小时）的目录在插件挂载时和每次新粘贴后自动删除。

## 验证

- `vitest run`：62 用例（61 通过 + 1 Windows 跳过）
- 双面 `tsc --noEmit`（host + client）+ `tsdown` 双面构建全绿
- dsh 零改动，无需回归

## 开发

本仓库遵循 **feature 分支 → PR → squash merge** 流程：master 受 GitHub ruleset 保护（强制 PR、禁 force push、禁删除），合入由 owner 明确指示。完整流程见 [`docs/development-workflow.md`](docs/development-workflow.md)。

开发本插件：所有 `@deepseek-ai/*` 包、react 与工具链均从本包 `node_modules` 解析（`^0.1.0-rc.6`），执行 `pnpm install` 即可，**不需要 harness 检出**；`tsdown.config.ts` 是本地 standalone 双面构建（host + client）。详见 `vision-plugin/README.md` 的 "Development" 一节。
