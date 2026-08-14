# dsh-vision-plugin 设计文档：DeepSeek 文本路由的惰性识图

- 日期：2026-02-11（修订 3：B 式纯插件改造，dsh 源码改动全部回退）
- 状态：已实现（B 式纯插件，16 测试全绿）；A 式（dsh 源码扩展点）已实现并验证后回退
- 关联仓库：
  - `<harness 仓库检出路径>`（master，**零改动**；A 式的本地开发分支已重置回 master）
  - `<本插件仓库检出路径>`（第三方插件项目，参考社区 `dsh-deep-whale` 皮肤的 bundle 形态）

## 0. 修订 3：B 式纯插件（当前方案）

社区调研（`awesome-dsh-plugin` 的 `dsh-vision-router` / `liustack/modlens`）后确认**纯插件路线可行**，最终采用 modlens 式 **paste-to-path**：

- **图片不进 prompt**：浏览器端 capture-phase 拦截粘贴 → `POST /vision-plugin/paste` → 私有临时文件（0600）→ **路径文本插入输入框**。host 的图片准入无从触发，agent-loop 的日志重建不变量天然满足——**dsh 源码零改动**。
- **识别**：DeepSeek 看到路径文本后主动调用 `describe_image` 工具（A 式真实会话已验证该行为）→ 插件用 `ctx.llm` 直连视觉模型（配置化 provider + 免费模型回退链）→ 描述文本返回。
- **verdict**：`GET /vision-plugin/paste?model=<选择器标签>` 按真实模型元数据裁决是否接管粘贴——视觉模型会话保留原生缩略图粘贴，文本模型会话转路径。
- **回退的 A 式资产**：`user/image-intake` 准入扩展点、`AttachmentStore.readImageById`、compaction 模态投影、Agent Note 三件套——全部撤销（分支重置为 master）。已实现的 A 式插件代码（准入 listener、`describe_attachment`、后台注入、占位解析）同样移除。
- **保留的资产**：识图服务（回退链/并发去重/空输出重试）、`describe_image` 工具、15→16 个测试、构建与解析基础设施。
- **已知代价**：粘贴的图片显示为路径文本而非缩略图（与 modlens 相同取舍）；`describe_image` 用 node fs 直读（临时路径在工作区外）。

## 1. 背景与目标

用户只有 DeepSeek 官方 API key（纯文本路由，`llm-deepseek` 适配器遇图片抛 `UNSUPPORTED_CONTENT`），但需要在对话中识别图片内容（物体、场景、图表语义），且不愿手动切换会话/模型。已确认 OpenRouter 为视觉供应商（DSH 设置中已注册，内置 pi-ai 目录含 4 个免费视觉模型）。

目标：在 DeepSeek 文本路由会话中粘贴图片后，图片内容自动变为文本描述进入上下文，全程一个会话、一个主模型；描述由插件内部调用视觉模型完成。

## 2. 需求与非目标

需求：
1. 用户消息携带图片时，文本路由不再拒绝（准入放行，由插件决定）。
2. 图片内容以文本描述形式进入 DeepSeek 上下文（自动识别，可配置等待；超时后由 agent 按需调用工具）。
3. 识图供应商无关：provider/model 全部可配置，默认 OpenRouter + 免费模型回退链。
4. agent 可随时主动调用 `describe_attachment` 工具；文件路径场景由 `describe_image` 覆盖。
5. 模型可见内容 ⟺ 会话日志可重建（仓库硬规则，由 agent-loop 运行时不变量强制）。

非目标（v1 不做）：
- 改 DeepSeek 官方适配器使其直接收图（端点不支持，物理不可行）。
- 子 agent 识图（子会话不支持图片，`SUBAGENT_IMAGE_UNSUPPORTED`；工具调用是更轻的等价机制）。
- 准入同步转描述的 eager 策略（v2 候选；v1 准入采用事件扩展点，见 D3）。
- agent-loop 请求投影扩展点（v1 不需要——投影发生在日志层面，见 D2 与 5.2）。
- 客户端改动（粘贴链路走现成 prompt RPC；文本路由历史显示占位文本，v2 再考虑缩略图渲染）。
- 视觉会话历史切换到文本模型（保持现状：需新会话，见 11 节风险 6）。

## 3. 现状（已核实的代码事实）

| 事实 | 位置 |
|---|---|
| 图片准入拒绝发生在模态检查 | `packages/host/apiproxy/src/api-proxy.ts:2488`（`MODEL_DOES_NOT_SUPPORT_IMAGES`），先于图片持久化（`durablePromptContent`） |
| **agent-loop 运行时不变量**：请求 messages 必须与会话日志 `deriveMessages()` JSON 相等，否则 turn 报错 | `packages/core/agent-loop/src/invariant.ts:39-42`（`log-reconstruction desync`）。**任何"改请求不改日志"的投影都会被拒绝**——投影必须发生在日志层面 |
| `ctx.llm.prepareCall({provider, model})` 直连可用 | `packages/llm/llm/src/index.ts:779`，返回一次性句柄 `.stream(GenerateOptions)` |
| 附件服务 | `ctx.attachments.saveImage/readImage/imageLimits`（`packages/attachment`） |
| compaction 原样转发历史消息（含图片块） | `packages/compaction/compaction-basic/src/summarizer.ts:146-153`；目标模型文本模态时序列化会抛 → 已适配（M1-C） |
| 会话标题生成只收集 text 块，图片块静默跳过 | `packages/session/session-title/src/index.ts:175-181`，无需改动 |
| 子会话图片拒绝 | `packages/client/runtime/src/client/sessions/session.ts:224`（客户端行为，保持现状） |
| 第三方插件形态 | `dsh-deep-whale/maid-atelier`：`@dsh-external/` scope、`cordis.patch.yml` 注册、`dsh plugin --profile web add <path>` 安装、tsdown + vitest |
| 内部包已发布 npm | `pnpm view @deepseek-ai/dsh-llm` → `0.0.1-rc.1`（插件依赖可解析；开发期指向本地改过的包） |
| OpenRouter 免费视觉模型（已装入的 pi-ai 目录） | `google/gemma-4-31b-it:free`、`google/gemma-4-26b-a4b-it:free`、`nvidia/nemotron-nano-12b-v2-vl:free`、`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |
| Cordis waterfall 事件：注册用 `ctx.on(name, listener)`，listener 签名 `(payload, next)`，不调 `next()` 即短路 | `vendor/cordis/src/events.ts:234-243`（`ctx.waterfall(name, ...)` 只有分发语义） |

## 4. 架构总览

```
用户粘贴图片 ──> prompt RPC ──> host 准入（api-proxy）
                                  │ 文本路由 → user/image-intake 扩展点
                                  │ 无 listener / 视觉不可用 → 拒绝（现状+提示）
                                  │ listener 放行 → durablePromptContent 持久化
                                  ▼
                        文本路由：image block → 占位文本（含 attachment_id）落日志
                        视觉路由：image block 原样落日志（现状）
                                  │
                        agent 循环 step()：deriveMessages()
                                  │ 请求 messages == 日志推导（invariant 天然成立）
                                  ▼
                        DeepSeek 首轮（快）→ 视情况调 describe_attachment
                                  │
                        ★ 插件 describe_attachment 工具
                                  │ ctx.llm.prepareCall(provider, model) 直连
                                  │ 回退链 → 描述文本 → tool/result 落日志
                                  ▼
                        DeepSeek 基于描述继续回答
```

组件：
- **dsh 源码改动（A 式，已实现并验证后回退）**：A. 准入事件扩展点 + 模态感知投影落日志（`dsh-host-apiproxy`）；C. compaction 模态感知投影（`dsh-compaction-basic`）；M1.5 `AttachmentStore.readImageById`（`dsh-attachment` + `attachment-local`）；`docs/architecture.md` 登记扩展点。
- **dsh-vision-plugin 项目（B 式，已实现）**：`describe_image` 工具、识图服务（回退链 + 去重 + 超时）、paste-to-path 端点与客户端拦截、包装模型（缩略图保留）。

## 5. 核心设计

### 5.1 准入事件扩展点 + 日志层面投影（M1-A，已实现）

`api-proxy.ts` 模态检查处改为 waterfall 事件 `user/image-intake`（类型与 `ImageIntakeDecision` 声明于 `dsh-host-apiproxy`）：

- 事件参数：`{ sessionId, provider, model, content }`；listener 返回 `{ allow: true }` 或 `{ allow: false, reason, message }`。
- **默认行为（无 listener / 调 `next()`）= 现状**：文本路由收图 → `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝；视觉路由照常放行（不经过该事件）。
- 插件 listener 语义：目标模型不含 image 模态时——
  - 视觉可用（`Config.provider` 已注册、模型可解析）→ `{ allow: true }`；
  - 视觉不可用 → `{ allow: false, reason: 'VISION_UNAVAILABLE', message: '未配置视觉模型供应商 <provider>，请在 设置→Models 添加该供应商并保存 API key' }`（`<provider>` 为配置值，不写死 OpenRouter）。
- **放行后的落日志投影（host 内置，`projectImagesForModel`）**：模态声明含 image → image block 原样；明确 text-only → image block 替换为**占位文本**（`imagePlaceholderText`，见 5.7）。未声明模态（undefined）→ 原样（保持现状，与 compaction 一致）。
- 关键性质：**文本路由的日志里从不出现 image block** → `deriveMessages()` 不含图 → 请求与日志天然一致 → agent-loop 的 log-reconstruction invariant 无需任何改动即成立（这是实现验证中发现并采纳的核心简化，见 D2）。

### 5.2 不需要 agent-loop 投影扩展点（M1-B 已取消）

原设计在 `agent/request-messages` 处做请求级投影，实现验证发现：
- `invariant.ts:39-42` 强制 `options.messages` 与 `deriveMessages()` JSON 相等——请求级投影必然触发 `log-reconstruction desync` 运行时失败；
- 日志层面投影（5.1）后，请求级投影成为多余。

**v1 结论**：投影只在日志写入时发生一次（准入处），agent-loop 零改动。视觉会话历史切换到文本模型（旧日志含 image block）保持现状"需新会话"（风险 6）。

### 5.3 compaction 投影适配（M1-C，已实现）

`summarizeWithLlm` 组装总结请求前，按目标模型模态投影：
- 目标模态含 image → 历史原样（视觉总结保留图片信息）。
- 明确 text-only → image block → `[图片已省略]` 占位文本（**只占位、不触发识图**——压缩路径不产生网络调用等待，D6）。
- 未声明模态 / 能力查询失败 → 原样（保持现状，与 host 准入的 undefined 语义一致）。
- 投影递归处理 `tool-result` 内层图片；消息对象重建（冻结输入不可变）。

### 5.4 插件：`describe_attachment` / `describe_image` 工具

- 注册：`ctx.inject(['attachments', 'llm', 'fs'], ...)` 后 `ctx.tools.register(defineTool({...}))`（参照 `tool-fs/src/read-image.ts` 模式）。
- `describe_attachment`：
  - `attachment_id: string`（必填）：占位文本中携带的 `attachmentId`。
  - `question: string`（可选）：对视觉模型的提问，默认"请详细描述这张图片的内容"（中文）。
  - 执行：校验 id 格式 → `attachments.readImage`（遵守 `imageLimits`）→ 识图服务（5.5）→ 返回文本信封（5.7）。
- `describe_image(file_path)`：`ctx.fs` 读本地图片文件 → `attachments.saveImage` 持久化 → 同上识图 → 文本信封。与 `read_image` 并存（read_image 要求路由支持 image，本工具不要求）。
- 渲染：generic 卡片（read 家族）。

### 5.5 插件：识图服务（供应商无关）

- 配置（`Config`，cordis.yml + settings 可配）：
  - `provider: string`（默认 `openrouter`）
  - `models: string[]`（有序回退链，默认 4 个免费模型；**默认值属于插件 Config schema，不属于 dsh 源码**）
  - `systemPrompt: string`（中文默认）
  - `maxOutputTokens: number`（默认 2048）
  - `timeoutMs: number`（单模型调用超时，默认 60_000）
  - `autoDescribeWaitMs: number`（首轮自动识别等待上限，默认 30_000；0 = 纯惰性）
  - `maxInputBytes: number`（默认取附件服务 `maxImageBytes`）
- 回退语义：按序 `prepareCall`；`RATE_LIMIT`/`TIMEOUT`/网络类错误/`UNKNOWN_MODEL` → 下一个模型；全挂 → 汇总错误（工具报错）。
- 去重：进程内 `Map<attachmentId, Promise<void>>` 仅作"识别是否已落日志"的索引（D5：日志是唯一真源）；并发识图去重；失败不落日志、下次重试；HMR 注销清空。

### 5.6 自动识别时序（autoDescribe）

1. 用户消息（占位文本）落日志；插件监听 `user/message` 事件发现新占位文本 → 解析 attachmentId → 后台启动识图（去重索引）。
2. agent 首轮 `deriveMessages()` 时：
   - 若识别已落日志（等待窗口内完成）→ 首轮请求天然包含描述文本（DeepSeek 直接回答）；
   - 未完成 → 首轮仅占位文本，DeepSeek 视情况调 `describe_attachment`（等待窗口内完成则工具秒回日志中的描述，未完成则工具触发识图并等待）。
3. 识别完成 → 插件 append `user/message`（source: plugin，内容见 5.7 识别结果模板，按 attachmentId 可匹配）→ 后续请求自动包含（模型可见 ⟺ 有日志，invariant 满足）。
4. 超时（`autoDescribeWaitMs`）后未完成：不自动注入，全走工具路径（D2：lazy 兜底）。

### 5.7 模型可见文本规范（固定逐字 + 快照）

- **占位文本**（host `imagePlaceholderText`，v1 中文固定；`<...>` 为渲染占位符，其余逐字固定）：
  ```
  [已附加图片 <name>（<width>x<height> px，attachment_id: <attachmentId>）。如需了解图片内容，请调用 describe_attachment 工具，并将 attachment_id 参数设为该值。]
  ```
  （`name` 缺失时用"图片"。）
- **识别结果消息**（插件 append，source: plugin）：
  ```
  [图片 <name> 的识别结果]
  <描述文本>
  ```
- **工具结果信封**（参照 `read_image` 风格）：
  ```
  <attachment_id><attachmentId></attachment_id>
  <question>...</question>
  <content>
  <描述文本>
  </content>
  ```
- **compaction 占位**：`[图片已省略]`（compaction-basic 内置）。

## 6. 错误处理与降级

| 场景 | 行为 |
|---|---|
| 视觉模型全挂 / 免费模型下架 | `describe_attachment` 返回工具错误（透传 LlmError 码）；首轮已由占位文本兜底，会话不中断 |
| 单模型 RATE_LIMIT/TIMEOUT | 回退链下一个模型 |
| 识图超时（autoDescribe） | 首轮占位文本；agent 走工具路径 |
| 图片字节超限 | 附件服务既有错误（`IMAGE_TOO_LARGE` 等），工具透传 |
| 附件不在会话引用中 | 工具错误（`ATTACHMENT_NOT_REFERENCED` 语义，v1.1 强化校验） |
| 未配置视觉供应商（`Config.provider` 未注册） | 准入 listener 维持拒绝 + 提示"未配置视觉模型供应商 <provider>，请在 设置→Models 添加该供应商并保存 API key"；图片不进日志 |
| 供应商已配但 key 缺失/无效 | 准入放行（key 无法在准入时验证）→ 识图请求 `MISSING_CREDENTIAL`/`AUTH` → 工具报错（指明检查 API key）→ agent 转述 |
| 插件未安装 | 无 listener → 准入维持拒绝，行为与今天完全一致 |
| 视觉会话历史切文本模型 | 保持现状：请求失败（适配器 `UNSUPPORTED_CONTENT`），需新会话（风险 6） |

## 7. 测试计划

- **dsh 改动（已实现，全部通过）**：
  - `user/image-intake`：无 listener 拒绝（现状回归）、放行后占位文本落日志（含 attachmentId、无 image block）、listener 拒绝携带自定义 reason/message、视觉路由不触发且 image block 原样、纯文本 prompt 不触发（`api-proxy-image-intake.spec.ts`，5 用例）。
  - compaction 投影：文本目标投影（顶层 + tool-result 嵌套）、视觉目标原样、未声明模态原样（`summarizer-image.spec.ts`，3 用例）。
  - 回归：apiproxy 21 文件 379 用例 + compaction/agent 全套 541 用例全绿；typecheck 全绿。
- **插件（M2）**：
  - 单元：schema 校验、回退链（mock `ctx.llm`）、去重、超时、`imageLimits` 边界、文本信封/占位解析格式。
  - REAL 组合测试：boot 加载 + mock llm，断言 `tool/call` + `tool/result` 事件、识别结果消息落日志、准入 listener 行为。
  - 快照：占位文本、信封、识别结果消息。
- **端到端（M3，独立实例）**：粘贴图片 → 自动识别 → DeepSeek 回答；识别超时 → 工具路径；无 key 场景准入提示；文本/视觉路由双验证。

## 8. 依赖与分发

- 插件包：`@dsh-external/dsh-vision-plugin`（scope 参照 dsh-deep-whale）。
- 项目布局：
  ```
  dsh-vision-plugin/
    README.md                    # M4：设计目标概要
    docs/vision-lazy-design.md   # 本文档
    vision-plugin/
      package.json               # dsh.bundle.patch → cordis.patch.yml
      cordis.patch.yml           # - insert: { id: vision-plugin, name: '@dsh-external/dsh-vision-plugin' }
      src/index.ts               # host 侧：准入 listener + 工具 + 识图服务 + 识别注入
      src/…                      # 模块拆分（service/describe/image-placeholder 等）
      tests/…
      tsdown.config.ts
  ```
- 依赖策略（实况）：
  - 插件 tsconfig extends dsh 的 `tsconfig.base.json`（paths 覆盖：vendor 指 `lib/types` 声明、dsh 包指 `src` 源码、`@deepseek-ai/dsh-host-apiproxy` 等目录名与包名不一致的包单独映射）。
  - 运行时/测试：插件 `node_modules` 以 junction 指向 dsh 仓库 `node_modules`（共享工具链），vitest 用 `resolve.tsconfigPaths` + vendor alias（vendor 包指 `src`，dsh 包指 `src`）。
  - **开发期**：插件代码直接消费 dsh 源码（含本地分支的新扩展点）；**分发期**：dsh 发布新版本后插件可切回 npm registry 依赖。
  - 运行时宿主是本地源码启动的 dsh 进程，扩展点行为来自宿主进程，插件包内类型仅编译期需要。
- 安装：`dsh plugin --profile web add <本插件检出路径>/vision-plugin`。

## 9. 里程碑

1. **M1 dsh 源码改动（已完成，已暂存未提交）**：A 准入事件 + 日志投影、M1.5 `readImageById`、C compaction 投影 + architecture.md + 全部测试（apiproxy 21 文件 379 用例、compaction/agent 541 用例、attachment 10 用例）与 typecheck 全绿。
2. **M2 插件包（已完成，已暂存）**：`@dsh-external/dsh-vision-plugin` 骨架 + 识图服务（回退链/去重/空输出重试）+ 准入 listener + `describe_attachment`/`describe_image` + 后台识别注入；15 个测试（单元 + 组合 + 占位解析）全绿，tsc 全绿。
3. **M3 端到端联调（进行中，需用户参与）**：独立实例（不同 DSH_HOME/端口）安装插件并验证：粘贴图片 → 自动识别 → DeepSeek 回答；识别超时 → 工具路径；无 key 场景准入提示；文本/视觉路由双验证。
4. **M4 收尾**：项目级 `README.md`（设计目标概要：为什么做、解决什么痛点、架构一句话、安装/配置、与 dsh 源码分支的关系；参照 dsh-deep-whale README 风格）+ 插件包 README（含 Model Experience 段）+ Agent Note（dsh 改动侧 + 插件侧各一）+ 仓库门禁（lint/duplication 等）。

## 10. 设计决策记录

- D1 **供应商无关**：识图调用走 `ctx.llm` 通用 seam，provider/model 全配置化；唯一约束是视觉调用必须在 pi-ai 适配器路由上（DeepSeek 官方适配器纯文本）。错误提示文案中的供应商名来自配置值。
- D2 **投影发生在日志层面，不做请求级投影**：实现验证发现 agent-loop invariant（请求 messages 必须等于日志推导）使请求级投影不可行；准入时一次性投影（image → 占位文本）使 invariant 天然成立，agent-loop 零改动。占位文本因此成为"模型可见且已落日志"的确定内容（D5 特例：占位文本本身在日志里，不需要额外事件）。
- D3 **准入用事件扩展点而非配置开关**：默认行为 = 拒绝（现状），listener 存在且视觉可用才放行；天然避免"开关开但无插件"的错误配置组合。
- D4 **事件/类型声明在 dsh 包内**（declare module 合并），插件开发期 file: 链接本地包拿类型。
- D5 **描述文本必须先落日志**：识别结果以插件来源 `user/message` 事件进日志，请求从日志重建；内存仅作"是否已落"的索引。
- D6 **compaction 只占位不触发识图**：压缩路径不产生网络调用等待。
- D7 **占位文本/信封/识别结果逐字固定**：快照锁定，防止模型可见文本漂移。
- D8 **插件 bundle 注册准入 listener**：安装即生效、卸载即还原；视觉不可用时准入 listener 维持拒绝。

## 11. 风险与开放问题

1. **识别结果事件类型**：用 `user/message`（source: plugin）——已确认可行（与 compaction checkpoint 的注入方式同族）；实现时按 session 事件声明合并规则落类型。
2. **占位文本的 UI 呈现**：文本路由历史显示占位文本而非缩略图；v2 客户端解析占位文本渲染缩略图（附件 RPC 已具备授权读图）。
3. **免费模型下架**：回退链 + 配置化缓解；模型刷新脚本（`GET https://openrouter.ai/api/v1/models` 过滤 `pricing.prompt=="0"` + image 模态）作为 README 附录。
4. ~~开关与插件的联动校验~~：扩展点语义已消除（listener 不存在 = 拒绝）。
5. **subagent 会话**：客户端已拒绝（保持现状）；未来子会话支持图片后再评估。
6. **视觉会话历史切文本模型**：旧日志含 image block → 请求失败（适配器拒绝 + invariant 通过但序列化抛错），需新会话。v2 候选：在 compaction/准入之外增加"文本路由读取含图历史时的投影"（需同步升级 invariant 的 expected 投影，工程较大）。
7. **`auto` 模型**（OpenRouter 自动路由）可作回退链最后一项候选，v1 不启用。
