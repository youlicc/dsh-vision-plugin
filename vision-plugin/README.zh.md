# @dsh-external/dsh-vision-plugin

文本路由的视觉桥接：粘贴的图片变成临时文件路径（paste-to-path），`describe_image` 工具通过可配置的视觉供应商读取它们并返回文字描述，composer 内还有视觉模型菜单，用于挑选识图所用的免费视觉模型。

## 功能

- **视觉模型菜单（composer）**：composer 工具行中的 `视觉：<模型>` 按钮（`conversation.input.right` 席位，发送按钮正前方）打开一个按供应商分组的下拉菜单，列出当前已配置供应商提供的**免费**视觉模型。免费清单由插件内置的 `FREE_VISION_MODELS` 目录维护（从不扫描模型元数据）：OpenRouter 的 4 个 `:free` 模型和 OpenCode 的 `mimo-v2.5-free`。默认选中目录顺序中的第一个可用模型；点击某个模型即切换下一次识图的视觉路由。若没有任何已配置供应商提供免费模型 → 按钮完全隐藏。
- **Paste-to-path 接收**：浏览器端（`lib/client.js`）在捕获阶段监听粘贴事件。当 host 判定当前选中的模型是纯文本时，接管粘贴：字节上传到 `POST /vision-plugin/paste`，落成私有（0600）临时文件（位于新建的不可预测临时目录），返回的路径以纯文本插入 composer。纯文本模型永远不会触发图片准入；视觉模型保留原生缩略图粘贴（verdict 将选择器标签与真实模型元数据比对，`GET /vision-plugin/paste?model=<label>`）。
- **`describe_image` 工具**：用 node 自身 fs 读取本地 PNG/JPEG/WebP/GIF 文件（工作区或粘贴的临时路径），通过附件服务持久化提交，经视觉模型链识别，返回文字描述。图片永远不会以图片块形式进入被路由模型的请求。
- **`describe_attachment` 工具**：按附件 id（`sha256:…`）直接从内容寻址附件存储（`$DSH_HOME/attachments/v1/objects/…`）重新读取持久化图片，从字节恢复媒体类型，并通过同一链路识别。当自动描述需要复核时，包装的 `(vision)` 模型正是通过该通道检查原始像素——重写文本携带附件 id，引导模型到这里而不是搜索本地文件。

## 配置

插件入口 `config`（cordis.yml / settings），全部可选：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | 缺省 | 视觉供应商路由。缺省（且 `models` 缺省）→ 由 composer 菜单选择决定；显式设置 → 显式配置优先。 |
| `models` | 缺省 | 有序回退链；第一个非空成功胜出。缺省（且 `provider` 缺省）→ 菜单选择 + 同供应商其余免费模型作回退。 |
| `systemPrompt` | 中文识图提示词 | 视觉调用的系统提示。 |
| `visionMenu` | `true` | composer 视觉模型菜单开关。关闭 → 识别只走显式配置。 |
| `pasteToPath` | `true` | 浏览器粘贴拦截开关。 |
| `pasteMaxBytes` | 20 MiB | 粘贴端点上传统计上限。 |
| `pasteRetentionMs` | 24h | 超过该时长的粘贴临时目录会被清理。 |
| `maxOutputTokens` | 2048 | 每次视觉调用的输出上限。 |
| `timeoutMs` | 60000 | 单个模型调用超时。 |
| `maxInputBytes` | 0（附件限制） | 单张待描述图片的字节上限。 |

## 行为说明

- 路由解析顺序：显式 `provider`/`models` 配置优先，其次 composer 菜单选择（含同供应商免费模型回退），最后是清晰报错，提示你在配置中设置供应商或在菜单中挑选免费模型。
- 菜单只列出**已配置供应商**（在 llm 拓扑中注册的路由）且只列插件自有目录中的**免费**模型；目录中没有任何免费视觉模型的供应商会被跳过。
- provider/model 是纯配置：切换到 SiliconFlow、Anthropic 或本地 Ollama 路由只是配置变更，从不改代码。唯一约束是视觉路由必须落在 pi-ai 适配器家族（DeepSeek 官方适配器是纯文本的）。
- 识别按图片字节在飞行中去重；字节相同的并发调用共享一次视觉请求。
- **多图消息并行识别**：包装 `(vision)` 回合中的 N 张图片会并发触发 N 次识别调用，因此 token 前停顿只按一次识别计（免费模型排队 30-80s），而非 N 次。单次识别失败降级为内联占位符，不会让整个请求失败。
- 粘贴路由和视觉模型菜单仅在存在 web server 时挂载（`ctx.inject(['webServer'])`）：无头部署仍是纯工具桥。
- 不要求修改任何 dsh 源码：插件只消费公开服务（`ctx.llm`、`ctx.attachments`、`ctx.tools`、`ctx.webServer`、`ctx.slots`）。

## 粘贴临时文件：生命周期与选型

- 粘贴的图片落在系统临时目录下的私有（0600）目录 `dsh-vision-paste-<随机>/paste-<epoch-ms>.<扩展名>`；composer 中的路径文本是模型需要的唯一引用。
- 这些目录是**一次性输入**：`cleanupStalePasteDirs` 会清掉任何最新文件早于 `pasteRetentionMs`（默认 24h）的 `dsh-vision-paste-*` 目录，在挂载时和每次成功粘贴后运行。过期图片不会在 TEMP 中累积，因此搜索"当前粘贴"的 agent 不会把旧图误当新粘贴。
- 当模型需要复核包装 `(vision)` 消息背后的图片（日志中没有路径）时的选型原则：优先选**最新**的 `dsh-vision-paste-*` 目录；最准确的选法是取**创建时间最贴近该消息时间戳**的目录——粘贴与消息一一对应，时间对齐能排除更旧的残留。

## 模型体验

### 经由视觉桥的供应商请求

#### 模型看到什么

视觉模型收到配置的中文系统提示、调用者的问题和图片，作为一条用户消息。主（纯文本）会话只看到临时文件路径文本，以及工具运行后的描述包络。

#### Token 影响

主会话的请求只携带描述文本；图片永远不进入文本路由。每次识别调用在视觉供应商路由上消耗 token；字节相同的重复调用在飞行中去重。

#### KV 缓存影响

视觉调用是独立的一次性请求；不与会话主路由共享供应商侧的重放状态。更改配置的视觉供应商或模型链只影响下一次识别，不会使主会话缓存前缀失效（主路由不受触碰）。

### 供应商响应

#### 模型看到什么

视觉文本作为 `describe_image` 工具结果呈现给主 agent；主模型基于描述进行推理。

#### Token 影响

描述文本作为工具结果进入主会话日志一次，并随日志一并重放。

#### KV 缓存影响

落地的描述追加到会话日志，因此之后的主路由请求会把它包含在持久前缀中。

## 开发

```sh
# 测试通过 tsconfig paths 解析 harness 源码树（见 vitest.config.ts）
vitest run
# 类型检查：单一 tsconfig.json 同时覆盖 host 程序（src/）与浏览器端（src/client）——
# 编辑器只自动发现 tsconfig.json，所以合并后的 project 正是 VSCode TS server 解析所用的
tsc --noEmit
# 双面构建：lib/index.js（host）+ lib/client.js（浏览器 lazy-CJS bundle）
tsdown
```

包的单一 tsconfig 继承 `deepseek-harness/tsconfig.base.client.json`（JSX + DOM lib），并为 host 半恢复 node types；运行时/测试解析把 vendored 框架包和 react 指向 harness 安装（Vite alias），把 dsh 包指向其已构建的 `lib/types` 声明（tsconfig paths）。构建需要 harness 的 `node_modules` 提供工具链。浏览器端是 `src/client/` 下的 TypeScript + React，由 harness 的共享 `clientBundle` 预设编译（`lib/client.js`），CSS Modules 在物化时以 `<style data-plugin>` 标签注入。

## 已知限制与待办

- **菜单选择不持久化** —— 页面刷新后回到默认（第一个可用免费模型）；记住上次选择待后续实现。
- **菜单中不含付费视觉模型** —— 菜单只列插件免费目录；付费模型仍是配置项。
- **粘贴的图片显示为路径文本而非缩略图** —— paste-to-path 的取舍（与社区 `modlens` 插件相同）；把临时路径渲染成缩略图的客户端渲染器待后续实现。
- **免费视觉模型有限流** —— OpenRouter `:free` 模型约 20 请求/分钟，且可能被上游下线；回退链和可配置模型清单可以吸收这一点。
- **识别结果不持久化** —— 相同字节仅在飞行中去重；按内容哈希键控的描述缓存待后续实现。
- **`describe_image` 用 node 自身 fs 读取** —— 能读 host 进程可读的任何路径（粘贴临时文件在工作区之外）；经 `ctx.fs` 的沙箱感知读取待后续实现。
- **不含像素级工具（裁剪/OCR/接地）** —— 社区 `dsh-vision-router` 包展示了该方向；见项目 README 的对比。
