import z from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";
import { BlockAssembler, LlmAdapter, LlmError, createUserMessage } from "@deepseek-ai/dsh-llm";
import { basename, extname, join, resolve } from "node:path";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { AttachmentError } from "@deepseek-ai/dsh-attachment";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { homedir, tmpdir } from "node:os";
//#region src/config.ts
/**
* Plugin configuration: the vision provider route, the ordered fallback model
* chain, and the recognition policy. All values are configurable from the
* plugin entry's `config` (cordis.yml / settings), so switching providers is a
* configuration change, never a code change.
* @module @dsh-external/dsh-vision-plugin/config
*/
const Config = z.object({
	provider: z.string(),
	models: z.array(z.string()),
	systemPrompt: z.string().default("你是图像识别助手。请用中文详细、准确地描述这张图片的内容，包括主体、场景、文字（如有）与细节。"),
	maxOutputTokens: z.natural().default(2048),
	timeoutMs: z.natural().default(6e4),
	maxInputBytes: z.natural().default(0),
	pasteMaxBytes: z.natural().default(20971520),
	pasteRetentionMs: z.natural().default(864e5),
	pasteToPath: z.boolean().default(true),
	wrappedModels: z.boolean().default(true),
	visionMenu: z.boolean().default(true)
});
//#endregion
//#region src/vision-models.ts
/**
* Free vision models by provider route, in display order. Extend this table
* when a new free vision model appears on a route.
*/
const FREE_VISION_MODELS = {
	openrouter: [
		"google/gemma-4-31b-it:free",
		"google/gemma-4-26b-a4b-it:free",
		"nvidia/nemotron-nano-12b-v2-vl:free",
		"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
	],
	opencode: ["mimo-v2.5-free"]
};
/**
* Resolve the provider groups offered by this deployment: routes registered
* in the llm topology, intersected with {@link FREE_VISION_MODELS}, with each
* listed model cross-checked against the provider's own catalog.
* @param ctx - the plugin context carrying the llm service.
* @returns the offered groups in catalog order.
*/
async function resolveVisionModelGroups(ctx) {
	const llm = ctx.get("llm");
	if (llm === void 0) return [];
	const providers = new Map(llm.listProviders().map((provider) => [provider.id, provider.name]));
	const groups = [];
	for (const [provider, modelIds] of Object.entries(FREE_VISION_MODELS)) {
		const displayName = providers.get(provider);
		if (displayName === void 0) continue;
		let catalog;
		try {
			catalog = await llm.listModels(provider);
		} catch {
			continue;
		}
		const catalogIds = new Set(catalog.map((model) => model.id));
		const models = modelIds.filter((id) => catalogIds.has(id)).map((id) => {
			return {
				id,
				name: catalog.find((model) => model.id === id)?.name ?? id
			};
		});
		if (models.length === 0) continue;
		groups.push({
			provider,
			displayName,
			models
		});
	}
	return groups;
}
/**
* The default selection: the first offered model of the first offered group,
* in catalog order.
* @param groups - the resolved provider groups.
* @returns the default route, or `undefined` when nothing is offered.
*/
function defaultVisionRoute(groups) {
	const first = groups[0];
	const model = first?.models[0];
	if (first === void 0 || model === void 0) return void 0;
	return {
		provider: first.provider,
		model: model.id
	};
}
/**
* Validate a selection candidate against the offered groups.
* @param groups - the resolved provider groups.
* @param route - the candidate provider/model pair.
* @returns whether the route is offered.
*/
function isOfferedRoute(groups, route) {
	return groups.find((candidate) => candidate.provider === route.provider)?.models.some((model) => model.id === route.model) ?? false;
}
//#endregion
//#region src/describe.ts
/**
* The provider-agnostic vision bridge: durably commits one image through the
* attachment service, calls the configured provider/model chain through
* `ctx.llm`, and returns the model's description text. Concurrent calls for
* identical bytes share a single in-flight task.
* @module @dsh-external/dsh-vision-plugin/describe
*/
/** Collect one stream into its assembled content blocks, failing on stream errors. */
async function collectText(stream) {
	const assembler = new BlockAssembler();
	for await (const chunk of stream) assembler.push(chunk);
	const finish = assembler.finish;
	if (finish.kind === "error") throw new LlmError(finish.failure.message, finish.failure.code);
	if (finish.kind === "aborted") throw new LlmError("vision call aborted", "ABORTED");
	return assembler.blocks();
}
/** The plugin's model-visible source tag for recognition messages. */
const VISION_SOURCE = {
	kind: "plugin",
	plugin: "dsh-vision-plugin"
};
var DescribeService = class {
	ctx;
	config;
	selection;
	inFlight = /* @__PURE__ */ new Map();
	constructor(ctx, config, selection) {
		this.ctx = ctx;
		this.config = config;
		this.selection = selection;
	}
	/**
	* Describe one image, sharing one in-flight task across concurrent callers
	* with identical bytes.
	* @param data - the encoded image bytes.
	* @param mediaType - the declared media type (validated against the bytes).
	* @param question - the model-facing question (Chinese by default).
	* @param name - optional display name for the durable reference.
	* @param signal - optional cancellation.
	* @returns the committed reference and the description text.
	*/
	describe(data, mediaType, question, name, signal) {
		const key = createHash("sha256").update(data).digest("hex");
		const existing = this.inFlight.get(key);
		if (existing !== void 0) return existing;
		const task = this.describeFresh(data, mediaType, question, name, signal).finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, task);
		return task;
	}
	async describeFresh(data, mediaType, question, name, signal) {
		const attachments = this.ctx.get("attachments");
		if (attachments === void 0) throw new Error("no attachment service is mounted");
		const maxBytes = this.config.maxInputBytes > 0 ? this.config.maxInputBytes : attachments.imageLimits.maxImageBytes;
		if (data.byteLength > maxBytes) throw new Error(`image exceeds the ${maxBytes}-byte recognition limit`);
		const ref = await attachments.saveImage({
			data,
			mediaType,
			...name === void 0 ? {} : { name }
		});
		const routes = this.resolveRoutes();
		if (routes.length === 0) throw new Error("未配置视觉模型供应商：请在插件配置中设置 provider/models，或在 composer 的“视觉模型”菜单中选择一个免费视觉模型");
		const failures = [];
		for (const route of routes) {
			signal?.throwIfAborted();
			try {
				const text = await this.callModel(ref, question, route, signal);
				if (text.trim().length > 0) return {
					ref,
					text
				};
				failures.push(`${route.provider}/${route.model}: empty description`);
			} catch (error) {
				if (signal?.aborted) throw error;
				failures.push(`${route.provider}/${route.model}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error(`all vision models failed: ${failures.join("; ")}`);
	}
	/** The ordered route chain: explicit config, else menu selection, else empty. */
	resolveRoutes() {
		if (this.config.provider !== void 0 && this.config.models !== void 0 && this.config.models.length > 0) return this.config.models.map((model) => ({
			provider: this.config.provider,
			model
		}));
		const selected = this.selection?.currentRoute();
		if (selected === void 0) return [];
		return [selected, ...(FREE_VISION_MODELS[selected.provider] ?? []).filter((model) => model !== selected.model).map((model) => ({
			provider: selected.provider,
			model
		}))];
	}
	async callModel(ref, question, route, signal) {
		const llm = this.ctx.get("llm");
		if (llm === void 0) throw new Error("no llm service is mounted");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
		const forward = () => controller.abort();
		signal?.addEventListener("abort", forward, { once: true });
		try {
			const prepared = await llm.prepareCall({
				provider: route.provider,
				model: route.model,
				maxTokens: this.config.maxOutputTokens
			}, controller.signal);
			const options = {
				...prepared.config,
				system: this.config.systemPrompt,
				messages: [createUserMessage({
					content: [{
						type: "text",
						text: question
					}, {
						type: "image",
						attachment: ref
					}],
					source: VISION_SOURCE
				})],
				signal: controller.signal
			};
			return (await collectText(prepared.stream(options))).filter((block) => block.type === "text").map((block) => block.text).join("");
		} catch (error) {
			if (controller.signal.aborted && signal?.aborted !== true) throw new LlmError(`vision model "${route.model}" timed out after ${this.config.timeoutMs}ms`, "TIMEOUT");
			throw error;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", forward);
		}
	}
};
//#endregion
//#region src/describe-image.ts
/**
* The `describe_image` tool: read a local PNG/JPEG/WebP/GIF file, durably
* commit it through the attachment service, describe it through the vision
* bridge, and return the description as text. The file is read with node's
* own fs (the paste-to-path temp files live outside the workspace), and the
* image never enters the routed model's request as an image block, so a
* text-only model can use it directly.
* @module @dsh-external/dsh-vision-plugin/describe-image
*/
/** Extensions `describe_image` accepts; magic-byte validation at the attachment service stays authoritative. */
const IMAGE_EXTENSIONS = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif"
};
/**
* Register the `describe_image` tool into the given context.
* @param ctx - the plugin context; execution uses the mounted attachment and llm services.
* @param describe - the shared vision bridge.
*/
function applyDescribeImageTool(ctx, describe) {
	ctx.tools.register(defineTool({
		name: "describe_image",
		description: "Read a PNG/JPEG/WebP/GIF image file and describe its content using a vision model, returning the description as text. Use whenever a message references an image the current model cannot see: a local file path (workspace or pasted temp path).",
		parameters: {
			file_path: {
				type: "string",
				required: true,
				description: "Absolute path to the image file."
			},
			question: {
				type: "string",
				description: "Optional question for the vision model."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					question: {
						type: "string",
						required: true
					},
					description: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `<path>${value.path}</path>\n<question>${value.question}</question>\n<content>\n${value.description}\n</content>`
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const filePath = args.file_path.trim();
			if (filePath.length === 0) throw new Error("file_path must be a non-empty string");
			const mediaType = IMAGE_EXTENSIONS[extname(filePath).toLowerCase()];
			if (mediaType === void 0) throw new Error(`cannot describe "${filePath}": describe_image only accepts PNG/JPEG/WebP/GIF paths`);
			const data = await readFile(filePath, { signal: exec.signal });
			const question = typeof args.question === "string" && args.question.trim().length > 0 ? args.question.trim() : "请详细描述这张图片的内容";
			let outcome;
			try {
				outcome = await describe.describe(data, mediaType, question, basename(filePath), exec.signal);
			} catch (error) {
				if (!(error instanceof AttachmentError) || error.code !== "IMAGE_TYPE_MISMATCH") throw error;
				const extension = extname(filePath).toLowerCase();
				throw new Error(`cannot describe "${filePath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`, { cause: error });
			}
			return {
				path: filePath,
				question,
				description: outcome.text
			};
		},
		presentCall(args) {
			return {
				card: "generic",
				title: `Describe image ${args.file_path}`,
				kind: "read",
				locations: [{ path: args.file_path }]
			};
		}
	}));
}
//#endregion
//#region src/attachment-reader.ts
/**
* Read one durable image attachment by content address alone. Attachments are
* content-addressed files under `$DSH_HOME/attachments/v1/objects/<prefix>/<sha256>`
* without an extension; the reader validates the id format, reads the file,
* and recovers the media type from the bytes — the pure-plugin counterpart of
* the (removed) `AttachmentStore.readImageById`, so a model that only knows an
* attachment id can still re-read the original image.
* @module @dsh-external/dsh-vision-plugin/attachment-reader
*/
const ID_PATTERN = /^sha256:([a-f0-9]{64})$/;
/** Magic-byte sniffs for the accepted raster formats. */
const SNIFFS$1 = [
	{
		mediaType: "image/png",
		test: (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([
			137,
			80,
			78,
			71,
			13,
			10,
			26,
			10
		]))
	},
	{
		mediaType: "image/jpeg",
		test: (buffer) => buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
	},
	{
		mediaType: "image/webp",
		test: (buffer) => buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP"
	},
	{
		mediaType: "image/gif",
		test: (buffer) => buffer.length >= 6 && buffer.subarray(0, 6).toString("latin1") === "GIF89a"
	}
];
/** Resolve the harness home: `$DSH_HOME` when set, else `~/.dsh`. */
function defaultHarnessHome() {
	const fromEnv = process.env.DSH_HOME;
	return resolve(fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), ".dsh"));
}
/**
* Read one durable image by content address.
* @param attachmentId - the durable `sha256:<hex>` address from the session log.
* @param home - the harness home to read from (defaults to `$DSH_HOME`/`~/.dsh`).
* @returns the verified bytes and the recovered media type.
* @throws when the id is malformed or no object exists at the address.
*/
async function readAttachmentById(attachmentId, home = defaultHarnessHome()) {
	const match = ID_PATTERN.exec(attachmentId);
	if (match?.[1] === void 0) throw new Error(`invalid attachment id "${attachmentId}": expected sha256:<64 hex digits>`);
	const sha256 = match[1];
	const objectPath = join(home, "attachments", "v1", "objects", sha256.slice(0, 2), sha256);
	let data;
	try {
		data = new Uint8Array(await readFile(objectPath));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error(`attachment ${attachmentId} is not stored (${objectPath} missing)`);
		throw error;
	}
	const buffer = Buffer.from(data);
	const sniff = SNIFFS$1.find((candidate) => candidate.test(buffer));
	if (sniff === void 0) throw new Error(`attachment ${attachmentId} is not a recognized image (png/jpeg/webp/gif)`);
	return {
		data,
		mediaType: sniff.mediaType
	};
}
//#endregion
//#region src/describe-attachment.ts
/** Default model-facing question for one recognition call. */
const DEFAULT_QUESTION = "请详细描述这张图片的内容";
/**
* Register the `describe_attachment` tool into the given context.
* @param ctx - the plugin context.
* @param describe - the shared vision bridge.
*/
function applyDescribeAttachmentTool(ctx, describe) {
	ctx.tools.register(defineTool({
		name: "describe_attachment",
		description: "Re-read an attached image by its attachment_id (sha256:…) and describe it using a vision model, returning the description as text. Use when a message references an image by attachment id and you need to inspect its content precisely.",
		parameters: {
			attachment_id: {
				type: "string",
				required: true,
				description: "The durable attachment id (sha256:…) carried in the message."
			},
			question: {
				type: "string",
				description: `Optional question for the vision model; defaults to "${DEFAULT_QUESTION}".`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					attachmentId: {
						type: "string",
						required: true
					},
					question: {
						type: "string",
						required: true
					},
					description: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `<attachment_id>${value.attachmentId}</attachment_id>\n<question>${value.question}</question>\n<content>\n${value.description}\n</content>`
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const attachmentId = args.attachment_id.trim();
			if (attachmentId.length === 0) throw new Error("attachment_id must be a non-empty string");
			const question = typeof args.question === "string" && args.question.trim().length > 0 ? args.question.trim() : DEFAULT_QUESTION;
			const stored = await readAttachmentById(attachmentId);
			return {
				attachmentId,
				question,
				description: (await describe.describe(stored.data, stored.mediaType, question, void 0, exec.signal)).text
			};
		},
		presentCall(args) {
			return {
				card: "generic",
				title: `Describe image ${args.attachment_id}`,
				kind: "read"
			};
		}
	}));
}
//#endregion
//#region src/paste.ts
/** Magic-byte sniffs for the accepted raster formats, with their extensions. */
const SNIFFS = [
	{
		ext: ".png",
		test: (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([
			137,
			80,
			78,
			71,
			13,
			10,
			26,
			10
		]))
	},
	{
		ext: ".jpg",
		test: (buffer) => buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
	},
	{
		ext: ".webp",
		test: (buffer) => buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP"
	},
	{
		ext: ".gif",
		test: (buffer) => buffer.length >= 6 && buffer.subarray(0, 6).toString("latin1") === "GIF89a"
	}
];
/**
* Persist one pasted image as a private temp file.
* @param data - the image bytes.
* @param maxBytes - the deployment's upload cap.
* @returns the absolute path of the written file.
* @throws when the bytes are not a recognized image or exceed the cap.
*/
async function handlePasteBytes(data, maxBytes) {
	if (data.byteLength > maxBytes) throw new Error(`image over the ${maxBytes}-byte limit`);
	const buffer = Buffer.from(data);
	const sniff = SNIFFS.find((candidate) => candidate.test(buffer));
	if (sniff === void 0) throw new Error("not a recognized image (png/jpeg/webp/gif)");
	const dir = await mkdtemp(join(tmpdir(), "dsh-vision-paste-"));
	const file = join(dir, `paste-${Date.now()}${sniff.ext}`);
	await writeFile(file, buffer, { mode: 384 });
	return file;
}
/** The temp-dir prefix owned by this plugin's paste intake. */
const PASTE_PREFIX = "dsh-vision-paste-";
/**
* Delete every paste temp directory whose files are older than the retention
* window. Pastes are one-shot inputs: once the path text reached the composer
* the directory has no further use, so leaving it behind would accumulate
* stale images that an agent searching for "the current paste" can mistake
* for a fresh one.
* @param retentionMs - directories whose newest file is older than this are removed.
* @param root - the temp root to sweep (defaults to the OS temp dir).
* @returns the number of removed directories.
*/
async function cleanupStalePasteDirs(retentionMs, root = tmpdir()) {
	const cutoff = Date.now() - retentionMs;
	let removed = 0;
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith(PASTE_PREFIX)) continue;
		const dir = join(root, entry.name);
		let newest = 0;
		for (const file of await readdir(dir)) try {
			const stat$1 = await stat(join(dir, file));
			if (stat$1.mtimeMs > newest) newest = stat$1.mtimeMs;
		} catch {}
		if (newest < cutoff) {
			await rm(dir, {
				recursive: true,
				force: true
			});
			removed += 1;
		}
	}
	return removed;
}
/**
* Whether the client should take a paste over for the currently selected
* model label. Only a model whose metadata positively confirms text-only is
* taken over; vision models and unknown labels keep their native paste.
* @param ctx - the plugin context carrying the llm service.
* @param label - the model-selector label text from the browser.
* @returns `true` when the label names a confirmed text-only model.
*/
async function pasteTakeoverVerdict(ctx, label) {
	if (typeof label !== "string" || label.trim() === "") return false;
	const llm = ctx.get("llm");
	if (llm === void 0) return false;
	const lowered = label.toLowerCase();
	let matchedAny = false;
	for (const provider of llm.listProviders()) {
		let models;
		try {
			models = await llm.listModels(provider.id);
		} catch {
			return false;
		}
		for (const model of models) for (const candidate of [model.name, model.id]) {
			if (typeof candidate !== "string" || candidate.length === 0) continue;
			if (!lowered.includes(candidate.toLowerCase())) continue;
			const modalities = model.inputModalities;
			if (modalities === void 0 || modalities.includes("image")) return false;
			if (candidate.length >= 3) matchedAny = true;
		}
	}
	return matchedAny;
}
/**
* Register the paste route on the web server. Never throws: a missing
* webServer (headless) leaves the plugin a tool-only bridge.
* @param ctx - the web-server scoped context.
* @param host - the plugin context, for verdict resolution.
* @param config - the resolved plugin configuration.
*/
function registerPasteRoute(ctx, host, config) {
	if (!config.pasteToPath) return;
	const webServer = ctx.get("webServer");
	if (webServer === void 0) return;
	cleanupStalePasteDirs(config.pasteRetentionMs);
	webServer.register({
		kind: "exact",
		path: "/vision-plugin/paste",
		handler: async (req, res) => {
			if (req.method === "GET") {
				const label = new URL(req.url ?? "", "http://localhost").searchParams.get("model") ?? "";
				try {
					const takeover = await pasteTakeoverVerdict(host, label);
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ takeover }));
				} catch (error) {
					res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }));
				}
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405).end();
				return;
			}
			try {
				const chunks = [];
				let total = 0;
				for await (const chunk of req) {
					total += chunk.length;
					if (total > config.pasteMaxBytes) {
						res.writeHead(413, { "content-type": "application/json" });
						res.end(JSON.stringify({ error: `image over the ${config.pasteMaxBytes}-byte limit` }));
						res.destroy();
						return;
					}
					chunks.push(chunk);
				}
				const path = await handlePasteBytes(Buffer.concat(chunks), config.pasteMaxBytes);
				cleanupStalePasteDirs(config.pasteRetentionMs);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ path }));
			} catch (error) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }));
			}
		}
	});
}
//#endregion
//#region src/wrapped-provider.ts
/** The model-visible text replacing one image block in the delegated request. */
function imageDescriptionText(name, description, attachmentId) {
	return `[图片 ${name === void 0 ? "图片" : name} 的识别结果（${attachmentId === void 0 ? "无需再寻找或复核本地图片文件" : `如需复核原图请调用 describe_attachment（attachment_id: ${attachmentId}），不要搜索本地文件`}）]\n${description}`;
}
/**
* The mirror adapter for one real text-only provider. Model metadata
* declares image input (so admission and `read_image`-style gates pass);
* `stream` rewrites image blocks into description text and delegates the
* rewritten request to the real route through the llm service (a hand-built
* call, so the loop's log-reconstruction invariant does not apply to the
* rewritten messages).
*/
var WrappedVisionAdapter = class extends LlmAdapter {
	host;
	describe;
	realProvider;
	descriptionCache = /* @__PURE__ */ new Map();
	constructor(host, describe, realProvider) {
		super();
		this.host = host;
		this.describe = describe;
		this.realProvider = realProvider;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: `${this.realProvider} (vision)`
		};
	}
	async listModels() {
		const llm = this.host.get("llm");
		if (llm === void 0) return [];
		return (await llm.listModels(this.realProvider)).filter((model) => model.inputModalities === void 0 || !model.inputModalities.includes("image")).map((model) => ({
			provider: `${this.realProvider}-vision`,
			id: model.id,
			name: `${model.name ?? model.id} (vision)`,
			...model.description === void 0 ? {} : { description: model.description },
			inputModalities: ["text", "image"]
		}));
	}
	async resolveModel(provider, model, signal) {
		const llm = this.host.get("llm");
		if (llm === void 0) return {
			provider,
			id: model,
			name: model
		};
		const info = await llm.resolveModelInfo(this.realProvider, model, signal);
		return {
			...info,
			provider,
			name: info.name ?? model,
			inputModalities: [...info.inputModalities ?? ["text"], "image"]
		};
	}
	async *stream(options) {
		const rewritten = await this.rewriteMessages(options.messages, options.signal);
		const llm = this.host.get("llm");
		if (llm === void 0) throw new Error("no llm service is mounted");
		const delegated = {
			...options,
			provider: this.realProvider,
			messages: rewritten
		};
		yield* llm.stream(delegated);
	}
	async rewriteMessages(messages, signal) {
		let changed = false;
		const out = [];
		for (const message of messages) {
			const content = await this.rewriteBlocks(message.content, signal);
			if (content !== message.content) {
				out.push({
					...message,
					content
				});
				changed = true;
			} else out.push(message);
		}
		return changed ? out : [...messages];
	}
	async rewriteBlocks(blocks, signal) {
		const imageTasks = [];
		for (let index = 0; index < blocks.length; index += 1) {
			const block = blocks[index];
			if (block.type === "image" && block.attachment !== void 0) imageTasks.push({
				index,
				promise: this.describeAttachment(block.attachment, signal)
			});
		}
		const descriptions = /* @__PURE__ */ new Map();
		if (imageTasks.length > 0) {
			const settled = await Promise.allSettled(imageTasks.map((task) => task.promise));
			for (let i = 0; i < settled.length; i += 1) {
				const outcome = settled[i];
				if (outcome === void 0) continue;
				if (outcome.status === "fulfilled") descriptions.set(imageTasks[i].index, outcome.value);
				else descriptions.set(imageTasks[i].index, `（图片识别失败：${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}）`);
			}
		}
		let changed = false;
		const out = [];
		for (let index = 0; index < blocks.length; index += 1) {
			const block = blocks[index];
			if (block.type === "image" && block.attachment !== void 0) {
				const description = descriptions.get(index);
				if (description !== void 0) {
					out.push({
						type: "text",
						text: imageDescriptionText(block.attachment.name, description, String(block.attachment.attachmentId))
					});
					changed = true;
					continue;
				}
			}
			if (block.type === "tool-result" && block.content !== void 0) {
				const content = await this.rewriteBlocks(block.content, signal);
				if (content !== block.content) {
					out.push({
						...block,
						content
					});
					changed = true;
					continue;
				}
			}
			out.push(block);
		}
		return changed ? out : [...blocks];
	}
	/** Describe one durable attachment, caching by content address. */
	describeAttachment(ref, signal) {
		const id = String(ref.attachmentId);
		const cached = this.descriptionCache.get(id);
		if (cached !== void 0) return cached;
		const safe = (async () => {
			const attachments = this.host.get("attachments");
			if (attachments === void 0) throw new Error("no attachment service is mounted");
			const stored = await attachments.readImage(ref, signal);
			return (await this.describe.describe(stored.data, stored.ref.mediaType, "请详细描述这张图片的内容", stored.ref.name, signal)).text;
		})().catch((error) => {
			this.descriptionCache.delete(id);
			throw error;
		});
		this.descriptionCache.set(id, safe);
		return safe;
	}
};
/**
* Register one mirror provider per text-only provider route, re-scanning when
* the llm topology changes.
* @param ctx - the plugin context.
* @param describe - the shared vision bridge.
* @param enabled - whether wrapping is configured on.
* @returns a disposer removing every mirror registration.
*/
function applyWrappedProviders(ctx, describe, enabled) {
	if (!enabled) return () => {};
	const handles = /* @__PURE__ */ new Map();
	let disposed = false;
	const scan = async () => {
		if (disposed) return;
		const llm = ctx.get("llm");
		if (llm === void 0) return;
		const textOnly = [];
		for (const provider of llm.listProviders()) {
			if (handles.has(provider.id)) continue;
			try {
				if ((await llm.listModels(provider.id)).some((model) => model.inputModalities !== void 0 && !model.inputModalities.includes("image"))) textOnly.push(provider.id);
			} catch {}
		}
		for (const realProvider of textOnly) {
			const wrappedId = `${realProvider}-vision`;
			try {
				const handle = llm.registerAdapter([wrappedId], new WrappedVisionAdapter(ctx, describe, realProvider));
				handles.set(realProvider, handle);
			} catch {}
		}
	};
	const initial = setTimeout(() => {
		scan();
	}, 0);
	const onUpdated = ctx.on("llm/adapters-updated", () => {
		scan();
	});
	return () => {
		disposed = true;
		clearTimeout(initial);
		onUpdated();
		for (const handle of handles.values()) handle();
		handles.clear();
	};
}
//#endregion
//#region src/vision-model-menu.ts
function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
function readBody(req, maxBytes) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > maxBytes) {
				reject(/* @__PURE__ */ new Error(`body over the ${maxBytes}-byte limit`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Register the vision-model menu endpoints.
* @param ctx - the web-server scoped context.
* @param host - the plugin context (llm service for topology).
* @param selection - the shared selection state.
*/
function registerVisionModelMenu(ctx, host, selection) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0) return;
	webServer.register({
		kind: "exact",
		path: "/vision-plugin/vision-models",
		handler: async (req, res) => {
			if (req.method !== "GET") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			try {
				const groups = await resolveVisionModelGroups(host);
				const current = selection.currentRoute();
				json(res, 200, {
					groups,
					current: current === void 0 ? null : current
				});
			} catch (error) {
				json(res, 500, { error: String(error instanceof Error ? error.message : error) });
			}
		}
	});
	webServer.register({
		kind: "exact",
		path: "/vision-plugin/vision-model",
		handler: async (req, res) => {
			if (req.method === "GET") {
				const current = selection.currentRoute();
				json(res, 200, current === void 0 ? null : current);
				return;
			}
			if (req.method !== "POST") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			try {
				const body = await readBody(req, 4096);
				const parsed = JSON.parse(body.toString("utf8"));
				if (typeof parsed.provider !== "string" || typeof parsed.model !== "string") {
					json(res, 400, { error: "body must be { provider: string, model: string }" });
					return;
				}
				const route = {
					provider: parsed.provider,
					model: parsed.model
				};
				if (!isOfferedRoute(await resolveVisionModelGroups(host), route)) {
					json(res, 400, { error: `no free vision model ${route.provider}/${route.model} is offered` });
					return;
				}
				selection.select(route);
				json(res, 200, route);
			} catch (error) {
				json(res, 500, { error: String(error instanceof Error ? error.message : error) });
			}
		}
	});
}
//#endregion
//#region src/vision-model-selection.ts
/** Owns the mutable current vision route and its change notifications. */
var VisionModelSelection = class {
	current;
	fallback;
	/** Listener invoked with the new route after each change (or undefined on reset). */
	listeners = /* @__PURE__ */ new Set();
	/** The current route, or the default when none was picked yet. */
	currentRoute() {
		return this.current ?? this.fallback;
	}
	/**
	* Refresh the default (first offered free model in catalog order).
	* @param route - the newly resolved default, or undefined when nothing is offered.
	*/
	updateDefault(route) {
		if (this.fallback?.provider === route?.provider && this.fallback?.model === route?.model) return;
		this.fallback = route;
		if (this.current === void 0) for (const listener of this.listeners) listener(this.currentRoute());
	}
	/**
	* Set the selected route (caller validates it against the offered groups).
	* @param route - the route to select.
	*/
	select(route) {
		if (this.current?.provider === route.provider && this.current.model === route.model) return;
		this.current = route;
		for (const listener of this.listeners) listener(route);
	}
	/** Drop the explicit selection, returning to the default. */
	reset() {
		if (this.current === void 0) return;
		this.current = void 0;
		for (const listener of this.listeners) listener(this.currentRoute());
	}
	/** Subscribe to selection changes; returns a disposer. */
	onChange(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
};
//#endregion
//#region src/index.ts
const name = "dsh-vision-plugin";
/** Services the plugin body reads through the context property proxy. */
const inject = ["tools", "systemPrompt"];
function apply(ctx, config) {
	const selection = new VisionModelSelection();
	const describe = new DescribeService(ctx, config, config.visionMenu ? selection : void 0);
	const refreshDefault = () => {
		resolveVisionModelGroups(ctx).then((groups) => {
			selection.updateDefault(defaultVisionRoute(groups));
		}).catch(() => {});
	};
	const initial = setTimeout(refreshDefault, 0);
	const onUpdated = ctx.on("llm/adapters-updated", refreshDefault);
	ctx.effect(() => () => {
		clearTimeout(initial);
		onUpdated();
	}, "dsh-vision-plugin: vision menu topology refresh");
	applyDescribeImageTool(ctx, describe);
	applyDescribeAttachmentTool(ctx, describe);
	const disposeWrapped = applyWrappedProviders(ctx, describe, config.wrappedModels);
	ctx.effect(() => disposeWrapped, "dsh-vision-plugin: wrapped vision providers");
	if (config.pasteToPath || config.visionMenu) ctx.inject(["webServer"], (scope) => {
		if (config.pasteToPath) registerPasteRoute(scope, ctx, config);
		if (config.visionMenu) registerVisionModelMenu(scope, ctx, selection);
	});
}
//#endregion
export { Config, apply, inject, name };
