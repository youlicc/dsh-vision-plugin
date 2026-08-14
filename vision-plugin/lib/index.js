import z from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";
import { BlockAssembler, LlmAdapter, LlmError, createUserMessage } from "@deepseek-ai/dsh-llm";
import { basename, extname, join } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { AttachmentError } from "@deepseek-ai/dsh-attachment";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { tmpdir } from "node:os";
const Config = z.object({
	provider: z.string().default("openrouter"),
	models: z.array(z.string()).default([...[
		"google/gemma-4-31b-it:free",
		"google/gemma-4-26b-a4b-it:free",
		"nvidia/nemotron-nano-12b-v2-vl:free",
		"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
	]]),
	systemPrompt: z.string().default("你是图像识别助手。请用中文详细、准确地描述这张图片的内容，包括主体、场景、文字（如有）与细节。"),
	maxOutputTokens: z.natural().default(2048),
	timeoutMs: z.natural().default(6e4),
	maxInputBytes: z.natural().default(0),
	pasteMaxBytes: z.natural().default(20 * 1024 * 1024),
	pasteToPath: z.boolean().default(true),
	wrappedModels: z.boolean().default(true)
});
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
	inFlight = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
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
		const failures = [];
		for (const model of this.config.models) {
			signal?.throwIfAborted();
			try {
				const text = await this.callModel(ref, question, model, signal);
				if (text.trim().length > 0) return {
					ref,
					text
				};
				failures.push(`${model}: empty description`);
			} catch (error) {
				if (signal?.aborted) throw error;
				failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error(`all vision models failed (${this.config.provider}): ${failures.join("; ")}`);
	}
	async callModel(ref, question, model, signal) {
		const llm = this.ctx.get("llm");
		if (llm === void 0) throw new Error("no llm service is mounted");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
		const forward = () => controller.abort();
		signal?.addEventListener("abort", forward, { once: true });
		try {
			const prepared = await llm.prepareCall({
				provider: this.config.provider,
				model,
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
			if (controller.signal.aborted && signal?.aborted !== true) throw new LlmError(`vision model "${model}" timed out after ${this.config.timeoutMs}ms`, "TIMEOUT");
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
	const file = join(await mkdtemp(join(tmpdir(), "dsh-vision-paste-")), `paste${sniff.ext}`);
	await writeFile(file, buffer, { mode: 384 });
	return file;
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
function imageDescriptionText(name, description) {
	return `[图片 ${name === void 0 ? "图片" : name} 的识别结果]\n${description}`;
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
		let changed = false;
		const out = [];
		for (const block of blocks) if (block.type === "image") {
			const description = await this.describeAttachment(block.attachment, signal);
			out.push({
				type: "text",
				text: imageDescriptionText(block.attachment.name, description)
			});
			changed = true;
		} else if (block.type === "tool-result") {
			const content = await this.rewriteBlocks(block.content, signal);
			if (content !== block.content) {
				out.push({
					...block,
					content
				});
				changed = true;
			} else out.push(block);
		} else out.push(block);
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
//#region src/index.ts
const name = "dsh-vision-plugin";
/** Services the plugin body reads through the context property proxy. */
const inject = ["tools", "systemPrompt"];
function apply(ctx, config) {
	const describe = new DescribeService(ctx, config);
	applyDescribeImageTool(ctx, describe);
	const disposeWrapped = applyWrappedProviders(ctx, describe, config.wrappedModels);
	ctx.effect(() => disposeWrapped, "dsh-vision-plugin: wrapped vision providers");
	if (config.pasteToPath) ctx.inject(["webServer"], (scope) => {
		registerPasteRoute(scope, ctx, config);
	});
}
//#endregion
export { Config, apply, inject, name };
