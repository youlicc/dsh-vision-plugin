# dsh-vision-plugin · DeepSeek Harness 文本路由识图插件

让 **DeepSeek 官方（纯文本）模型也能"看图"** 的视觉桥接插件：粘贴图片不再被拒绝，图片内容变成文本描述进入上下文，全程一个会话、一个主模型。**纯插件实现，不修改 dsh 源码。**

## 设计目标

- **解决什么痛点**：DeepSeek 官方 API 是纯文本路由，用户粘贴图片会被直接拒绝（`MODEL_DOES_NOT_SUPPORT_IMAGES`），必须手动切换会话和视觉模型、再把识别结果搬回文本会话——极其繁琐。
- **怎么做（paste-to-path，借鉴社区 `modlens` 方案）**：浏览端在粘贴事件上抢先拦截图片 → 字节上传到插件的 webServer 端点（`POST /vision-plugin/paste`）→ 落成私有临时文件 → **文件路径以纯文本插入输入框**。图片从不进入 prompt，文本路由的准入无从拒绝；DeepSeek 看到路径文本后主动调用 `describe_image` 工具（你的验证会话已证明 agent 会这么做）→ 插件用可配置的视觉模型（默认 OpenRouter 免费模型链）识别 → 描述文本返回并进入上下文。
- **架构一句话**：图片只存在于磁盘临时文件与附件存储，模型可见内容全是文本——不触碰 host 准入、agent 循环、日志不变量（invariant 天然满足）；视觉调用通过 `ctx.llm` 直连，供应商无关（provider/model 全配置化）。
- **不做什么**：不改 DeepSeek 适配器、不改 agent 循环、不改任何 dsh 源码、不引入子 agent、不做路由接管（对比社区的 stealth 方案，见下文）。

## 组成

```
dsh-vision-plugin/
  docs/vision-lazy-design.md   # 完整设计文档（含 A 式→B 式演进记录）
  vision-plugin/               # 插件包 @dsh-external/dsh-vision-plugin
    src/                       # host 侧：paste 端点 + 识图服务 + describe_image 工具
    client.js                  # 浏览器侧：粘贴拦截（手写 lazy-CJS，零构建）
    tests/                     # 16 个测试（单元 + 组合）
    cordis.patch.yml           # bundle 注册
```

## 依赖关系

- **dsh 源码：零改动**。插件只用 dsh 的公开服务（`ctx.llm`、`ctx.attachments`、`ctx.tools`、`ctx.webServer`）。
- 视觉调用走 `ctx.llm` 通用 seam：provider/model 全部配置化，默认 OpenRouter + 4 个免费视觉模型回退链（`google/gemma-4-31b-it:free` 等），可换成任何已注册路由（SiliconFlow、Anthropic、本地 Ollama…）。

## 安装与配置

```sh
# 在 deepseek-harness 仓库根执行
pnpm dsh plugin --profile web add /path/to/dsh-vision-plugin/vision-plugin
# 重启 dsh web 服务
```

插件默认配置即开即用（provider=`openrouter` + 免费模型链）；需要自定义时在插件配置面修改：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `provider` | `openrouter` | 视觉模型路由（任何已注册 llm 路由） |
| `models` | 4 个 OpenRouter 免费视觉模型 | 有序回退链 |
| `systemPrompt` | 中文识图提示词 | 视觉调用系统提示 |
| `pasteToPath` | `true` | 是否启用浏览器粘贴拦截（`false` 则恢复原生粘贴行为，只用工具） |
| `pasteMaxBytes` | 20MB | 粘贴上传字节上限 |
| `maxOutputTokens` / `timeoutMs` / `maxInputBytes` | 2048 / 60000 / 0 | 视觉调用参数 |

## 使用

1. **粘贴图片**：在 DeepSeek 会话 Ctrl+V 粘贴 → 输入框出现图片的**临时文件路径** → 发送 → agent 自动调用 `describe_image` → 描述进入上下文（5–30 秒）；
2. **本地图片**：对 agent 说"用 describe_image 看一下 `<路径>`"；
3. **视觉模型会话**：粘贴走原生缩略图路径（客户端会先询问 host 的 verdict，只有确认为文本模型才接管粘贴）。

已知限制（v1）：粘贴的图片在消息里显示为路径文本而非缩略图；免费模型有频率限制（约 20 请求/分钟）。

## 验证

- 插件：`vitest run`（16 测试）+ `tsc --noEmit` 全绿；
- dsh：零改动，无需回归；
- 端到端：早期 A 式（准入扩展点）版本已在真实实例验证三条路径；B 式（纯插件）的核心链路（工具识别 + 临时文件读取）由组合测试覆盖，粘贴拦截待真实实例复验。

## 与社区方案的关系

本插件与 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 中的视觉插件目标相同，实现取舍不同：

| 方案 | 机制 | 取舍 |
|---|---|---|
| `dsh-vision-router` | stealth 路由接管 + adapter 层改写 | 图片保留缩略图，但机制复杂（单文件 130KB+），重写模型选择语义 |
| `liustack/modlens` | **paste-to-path**（粘贴转路径）+ 工具 | 轻（33KB + 8KB 客户端）、零 hook，但粘贴显示为路径 |
| **本插件** | **paste-to-path + `ctx.llm` 直连 + 免费模型回退链** | 与 modlens 同路线；视觉通道走已配置的 OpenRouter 路由（免本地 OCR 引擎），回退链保证可用性 |

可借鉴的后续项：描述缓存回填、`registerConfigurableProviders` 配置面（设置页可视配置）、像素级工具链（crop/OCR/grounding）。
