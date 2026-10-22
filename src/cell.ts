export const CELL_GLOBALS = ["tools", "ALL_TOOLS", "toolSchema", "text", "image", "audio", "generatedImage", "notify", "store", "load", "yield_control", "exit", "setTimeout", "clearTimeout", "fetch"] as const;

export const CELL_SCOPE = String.raw`(host, definitions, stored) => {
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const clone = (value) => value === undefined ? undefined : jsonParse(jsonStringify(value));
  const pending = new Set();
  const quiet = (value) => {
    if (!value || typeof value.then !== "function") return;
    const settled = value.then(() => {}, () => {});
    pending.add(settled);
    settled.then(() => pending.delete(settled));
  };
  const drain = () => Promise.all([...pending]);
  const stringify = (value) => {
    if (value === null || ["undefined", "boolean", "number", "bigint", "string"].includes(typeof value)) return String(value);
    if (Object.prototype.toString.call(value) === "[object Error]") return String(value);
    return jsonStringify(value) ?? String(value);
  };
  const scriptStack = (stack) => typeof stack !== "string" ? "" : stack.split("\n").filter((line) => !/^\s+at /.test(line) || /<anonymous>|cell\.js/.test(line)).map((line) => line.replace(/eval at .*?\), (<anonymous>)/, "$1")).join("\n");
  const errorText = (error) => {
    if (!error) return String(error);
    const message = error.message;
    const label = message && error.name ? error.name + ": " + message : message;
    const stack = scriptStack(error.stack);
    if (stack && label && !stack.startsWith(label)) return label + "\n" + stack;
    return stack || label || String(error);
  };
  const dataUrl = (block) => {
    const mime = block.mimeType ?? block.mime_type;
    return /^data:/i.test(block.data) ? block.data : "data:" + (typeof mime === "string" && mime ? mime : "application/octet-stream") + ";base64," + block.data;
  };
  const normalizeImage = (value, detail) => {
    const expected = "image expects a non-empty image URL string, an object with exactly one of image_url or file_id and optional detail, or a raw MCP image block";
    if (detail != null && typeof detail !== "string") throw "image detail must be a string when provided";
    let url;
    let fileId;
    let embedded;
    if (typeof value === "string") url = value;
    else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (value.file_id !== undefined) {
        if (value.image_url !== undefined || typeof value.file_id !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(value.file_id)) throw "image file_id is malformed or ambiguous";
        fileId = value.file_id;
        embedded = value.detail;
        if (embedded != null && typeof embedded !== "string") throw "image detail must be a string when provided";
      } else if (value.image_url !== undefined) {
        url = value.image_url;
        if (typeof url !== "string") throw expected;
        embedded = value.detail;
        if (embedded != null && typeof embedded !== "string") throw "image detail must be a string when provided";
      } else {
        const block = jsonParse(jsonStringify(value));
        if (typeof block?.type !== "string") throw expected;
        if (block.type !== "image") throw "image only accepts MCP image blocks, got \"" + block.type + "\"";
        if (typeof block.data !== "string" || !block.data) throw "image expected MCP image data";
        url = dataUrl(block);
        const metadata = block._meta?.["codex/imageDetail"];
        if (["auto", "low", "high", "original"].includes(metadata)) embedded = metadata;
      }
    } else throw expected;
    if (!url && !fileId) throw expected;
    if (url && /^https?:/i.test(url)) throw "Tool call failed: remote image URLs are not supported in tool outputs. Pass a base64 data URI instead";
    if (url && !/^data:/i.test(url)) throw "Tool call failed: invalid image output. Pass a base64 data URI instead";
    const selected = String(detail ?? embedded ?? "high").replace(/[A-Z]/g, (character) => character.toLowerCase());
    if (!["auto", "low", "high", "original"].includes(selected)) throw "image detail must be one of: auto, low, high, original";
    return fileId ? { type: "input_image", file_id: fileId, detail: selected } : { type: "input_image", image_url: url, detail: selected };
  };
  const normalizeAudio = (value) => {
    const expected = "audio expects a non-empty audio URL string, an object with audio_url, or a raw MCP audio block";
    let url;
    if (typeof value === "string") url = value;
    else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (value.audio_url !== undefined) {
        url = value.audio_url;
        if (typeof url !== "string") throw expected;
      } else {
        const block = jsonParse(jsonStringify(value));
        if (typeof block?.type !== "string") throw expected;
        if (block.type !== "audio") throw "audio only accepts MCP audio blocks, got \"" + block.type + "\"";
        if (typeof block.data !== "string" || !block.data) throw "audio expected MCP audio data";
        url = dataUrl(block);
      }
    } else throw expected;
    if (!url) throw expected;
    if (!/^data:/i.test(url)) throw "Tool call failed: invalid audio output. Pass a base64 data URI instead";
    return { type: "input_audio", audio_url: url };
  };
  const writes = {};
  const memory = new Map(Object.entries(stored ?? {}));
  const EXIT = Symbol("exit");
  const declared = Object.create(null);
  for (const definition of definitions) {
    Object.defineProperty(declared, definition.name, {
      enumerable: true,
      value(input) {
        const promise = Promise.resolve(host.call(definition.tool_name, input === undefined && definition.kind === "function" ? {} : input));
        quiet(promise);
        return promise;
      },
    });
  }
  Object.freeze(declared);
  const tools = new Proxy(declared, {
    get(target, name) {
      if (Object.prototype.hasOwnProperty.call(target, name)) return target[name];
      if (typeof name !== "string" || name === "then") return undefined;
      return () => {
        const error = new Error("TOOL_NOT_AVAILABLE: Tool \"" + name + "\" is not available in this Code Mode execution. Check ALL_TOOLS for callable names. A tool exposed directly by the host may need to be called through its direct tool entry instead.");
        error.code = "TOOL_NOT_AVAILABLE";
        error.tool = name;
        const promise = Promise.reject(error);
        quiet(promise);
        return promise;
      };
    },
  });
  const ALL_TOOLS = Object.freeze(definitions.map((tool) => Object.freeze({ name: tool.name, description: tool.description })));
  const toolSchema = (name) => {
    if (typeof name !== "string" || !name) throw "toolSchema expects a non-empty tool name";
    const tool = definitions.find((entry) => entry.name === name || entry.tool_name === name);
    return tool ? clone({ inputSchema: tool.parameters ?? null, outputSchema: null }) : undefined;
  };
  const content = (item) => quiet(host.content(item));
  const text = (value) => content({ type: "input_text", text: stringify(value) });
  const image = (value, detail) => content(normalizeImage(value, detail));
  const audio = (value) => content(normalizeAudio(value));
  const generatedImage = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw "generatedImage expects an image generation result object";
    const hint = value.output_hint;
    if (hint !== undefined && typeof hint !== "string") throw "generatedImage output_hint must be a string when provided";
    content(normalizeImage(value));
    if (hint !== undefined) content({ type: "input_text", text: hint });
  };
  const notify = (value) => {
    const notification = stringify(value);
    if (!notification.trim()) throw "notify expects non-empty text";
    quiet(host.notify(notification));
  };
  const key = (value, helper) => {
    try { return String(value); } catch { throw helper + " key must be a string"; }
  };
  const store = (name, value) => {
    const normalized = key(name, "store");
    const encoded = jsonStringify(value);
    if (encoded === undefined) throw "Unable to store " + jsonStringify(normalized) + ". Only plain serializable objects can be stored.";
    memory.set(normalized, jsonParse(encoded));
    writes[normalized] = jsonParse(encoded);
  };
  const load = (name) => {
    const normalized = key(name, "load");
    return memory.has(normalized) ? clone(memory.get(normalized)) : undefined;
  };
  const yield_control = () => quiet(host.yield());
  const exit = () => { throw EXIT; };
  const setTimer = host.setTimeout ?? ((callback, delay, ...rest) => setTimeout(callback, delay, ...rest));
  const clearTimer = host.clearTimeout ?? ((id) => clearTimeout(id));
  const fetch = (input, init) => Promise.resolve(host.fetch(new Request(input, init)));
  const values = [tools, ALL_TOOLS, toolSchema, text, image, audio, generatedImage, notify, store, load, yield_control, exit, setTimer, clearTimer, fetch];
  return {
    async run(build) {
      try {
        const script = build();
        try {
          await script(...values);
        } catch (error) {
          if (error !== EXIT) throw error;
        }
        await drain();
        return { stored: writes };
      } catch (error) {
        await drain();
        return { error: errorText(error), stored: writes };
      }
    },
  };
}`;
