var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../../src/feedback/server/Handler.ts
var Handler_exports = {};
__export(Handler_exports, {
  feedback: () => feedback
});

// ../../src/feedback/Report.ts
function prompt(report) {
  const page2 = report.title ? `"${report.title}" (${report.url})` : report.url;
  return [
    `Feedback on ${page2}, seen in a ${report.viewport.width}\xD7${report.viewport.height} viewport:`,
    "",
    ...report.comments.map(
      (comment, index) => [
        `${index + 1}. ${comment.note}`,
        `   On <${comment.tag}> at ${comment.selector}${comment.text ? `: "${comment.text}"` : ""}`
      ].join("\n")
    )
  ].join("\n");
}
__name(prompt, "prompt");

// ../../src/feedback/server/Issue.ts
var prefix = "issues/";
function create(options) {
  const random = Array.from(
    crypto.getRandomValues(new Uint8Array(4)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
  const at = options.at ?? Date.now();
  return {
    at,
    id: "iss_" + at.toString(36).padStart(9, "0") + random,
    report: options.report,
    reporter: options.reporter ?? null,
    resolution: null,
    status: "open",
    version: 1
  };
}
__name(create, "create");
function key(id) {
  return prefix + id;
}
__name(key, "key");
function parse(value) {
  if (!record(value)) return { error: "Send the report as a JSON object.", ok: false };
  if (typeof value.title !== "string") return { error: "title must be a string.", ok: false };
  if (!page(value.url)) return { error: "url must be an http or https URL.", ok: false };
  const viewport = value.viewport;
  if (!record(viewport) || !numbers(viewport, ["height", "width"]))
    return { error: "viewport must hold a numeric height and width.", ok: false };
  const comments = value.comments;
  if (!Array.isArray(comments) || comments.length === 0)
    return { error: "comments must list at least one comment.", ok: false };
  const parsed = [];
  for (const [index, comment] of comments.entries()) {
    const rect = record(comment) ? comment.rect : void 0;
    if (!record(comment) || typeof comment.note !== "string" || !comment.note.trim() || typeof comment.selector !== "string" || typeof comment.tag !== "string" || typeof comment.text !== "string" || !record(rect) || !numbers(rect, ["height", "width", "x", "y"]))
      return {
        error: `comments[${index}] needs a note, selector, tag, text and a numeric rect.`,
        ok: false
      };
    parsed.push({
      note: comment.note.trim(),
      rect: { height: rect.height, width: rect.width, x: rect.x, y: rect.y },
      selector: comment.selector,
      tag: comment.tag,
      text: comment.text
    });
  }
  return {
    ok: true,
    report: {
      comments: parsed,
      title: value.title,
      url: value.url,
      viewport: { height: viewport.height, width: viewport.width }
    }
  };
}
__name(parse, "parse");
function prompt2(issue) {
  return [
    `Issue ${issue.id}${issue.reporter ? ` from ${issue.reporter}` : ""}. ${prompt(issue.report)}`,
    "",
    `The issue is the kv value ${key(issue.id)} in this app. When it is resolved, set its status to "accepted" or "closed" and its resolution to what changed.`
  ].join("\n");
}
__name(prompt2, "prompt");
function summary(issue) {
  return { at: issue.at, id: issue.id, resolution: issue.resolution, status: issue.status };
}
__name(summary, "summary");
function numbers(value, keys) {
  return keys.every((name) => typeof value[name] === "number" && Number.isFinite(value[name]));
}
__name(numbers, "numbers");
function page(value) {
  if (typeof value !== "string") return false;
  const url = URL.parse(value);
  return url?.protocol === "http:" || url?.protocol === "https:";
}
__name(page, "page");
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(record, "record");

// ../../src/feedback/server/Handler.ts
function feedback(options) {
  const base = (options.path ?? "/feedback").replace(/\/+$/, "");
  const gateway = new URL(options.gateway ?? "https://gateway.tempo-dev.workers.dev").origin;
  const help = { href: gateway + "/key", text: "Get a Tempo Key" };
  let checked;
  const call = /* @__PURE__ */ __name((path, body) => fetch(gateway + path, {
    ...body === void 0 ? {} : { body: JSON.stringify(body) },
    headers: {
      accept: "application/json",
      authorization: "Bearer " + options.key,
      "content-type": "application/json",
      "gateway-app": options.app
    },
    method: body === void 0 ? "GET" : "POST"
  }), "call");
  const probe = /* @__PURE__ */ __name(async () => {
    if (!options.key)
      return {
        help,
        ready: false,
        reason: "The feedback handler has no Tempo Key. Give Handler.feedback the key of the wallet whose app collects the issues."
      };
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.app))
      return { help, ready: false, reason: "The app must match [a-z0-9][a-z0-9-]{0,62}." };
    const response = await call("/api/keys/me").catch((error) => error);
    if (response instanceof Error)
      return { help, ready: false, reason: `The gateway did not answer: ${response.message}` };
    if (!response.ok)
      return {
        help,
        ready: false,
        reason: `The gateway refused the Tempo Key: ${await detail(response)}`
      };
    const me = await response.json();
    return { agent: options.agent ?? null, app: options.app, ready: true, wallet: me.wallet };
  }, "probe");
  const check = /* @__PURE__ */ __name(async () => {
    const readiness = await (checked ??= probe());
    if (!readiness.ready) checked = void 0;
    return readiness;
  }, "check");
  const file = /* @__PURE__ */ __name(async (request) => {
    const readiness = await check();
    if (!readiness.ready) return Response.json(readiness, { status: 503 });
    const body = await request.json().catch(() => void 0);
    const parsed = parse(body);
    if (!parsed.ok) return problem(400, parsed.error);
    if (options.accept && !await options.accept({ report: parsed.report, request }))
      return problem(403, "This report was not accepted.");
    const issue = create({
      report: parsed.report,
      reporter: await options.identify?.(request) ?? void 0
    });
    const stored = await call("/v1/kv/set", {
      ifVersion: null,
      key: key(issue.id),
      public: options.public ?? false,
      value: issue
    });
    if (!stored.ok) return problem(stored.status, await detail(stored));
    const agent = options.agent ? await call(`/v1/agents/${encodeURIComponent(options.agent)}/turns`, {
      prompt: prompt2(issue)
    }).then(
      async (response) => response.ok ? "started" : await detail(response),
      (error) => error instanceof Error ? error.message : String(error)
    ) : null;
    return Response.json({ agent, id: issue.id, link: `${base}/${issue.id}` }, { status: 201 });
  }, "file");
  const read = /* @__PURE__ */ __name(async (id) => {
    const readiness = await check();
    if (!readiness.ready) return Response.json(readiness, { status: 503 });
    const response = await call("/v1/kv/get", { key: key(id) });
    if (!response.ok) return problem(response.status, await detail(response));
    const entry = await response.json();
    if (!entry) return problem(404, `No issue ${id}.`);
    return Response.json(summary(entry.value));
  }, "read");
  const list = /* @__PURE__ */ __name(async (request) => {
    if (!options.admin || !await options.admin(request)) return problem(404, "Not found.");
    const readiness = await check();
    if (!readiness.ready) return Response.json(readiness, { status: 503 });
    const cursor = new URL(request.url).searchParams.get("cursor");
    const response = await call("/v1/kv/list", {
      ...cursor ? { cursor } : {},
      prefix
    });
    if (!response.ok) return problem(response.status, await detail(response));
    const page2 = await response.json();
    return Response.json({ cursor: page2.cursor, issues: page2.entries.map((entry) => entry.value) });
  }, "list");
  return {
    fetch: /* @__PURE__ */ __name(async (request) => {
      const path = new URL(request.url).pathname.replace(/\/+$/, "");
      const rest = (() => {
        if (path === base) return "";
        if (path.startsWith(base + "/")) return path.slice(base.length + 1);
        return void 0;
      })();
      if (rest === void 0) return problem(404, "Not found.");
      if (rest === "" && request.method === "GET") {
        const readiness = await check();
        return Response.json(readiness, { status: readiness.ready ? 200 : 503 });
      }
      if (rest === "" && request.method === "POST") return file(request);
      if (rest === "issues" && request.method === "GET") return list(request);
      if (/^iss_[0-9a-z]+$/.test(rest) && request.method === "GET") return read(rest);
      return problem(404, "Not found.");
    }, "fetch")
  };
}
__name(feedback, "feedback");
async function detail(response) {
  const body = await response.json().catch(() => void 0);
  return typeof body?.detail === "string" ? body.detail : `The gateway answered ${response.status}.`;
}
__name(detail, "detail");
function problem(status, detail2) {
  return Response.json(
    { detail: detail2, status },
    { headers: { "content-type": "application/problem+json" }, status }
  );
}
__name(problem, "problem");

// worker.ts
var feedback2;
var worker_default = {
  fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith("/feedback")) return env.ASSETS.fetch(request);
    feedback2 ??= Handler_exports.feedback({
      accept: /* @__PURE__ */ __name((context) => context.request.headers.get("origin") === new URL(context.request.url).origin, "accept"),
      admin: /* @__PURE__ */ __name((request2) => !!env.TEMPO_ADMIN && request2.headers.get("authorization") === "Bearer " + env.TEMPO_ADMIN, "admin"),
      agent: env.TEMPO_AGENT,
      app: env.TEMPO_APP,
      gateway: env.TEMPO_GATEWAY,
      key: env.TEMPO_KEY
    });
    return feedback2.fetch(request);
  }
};

// ../../../../tempoxyz/gateway/node_modules/.pnpm/wrangler@4.152.0_@types+node@26.6.5/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../tempoxyz/gateway/node_modules/.pnpm/wrangler@4.152.0_@types+node@26.6.5/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-6YEFcK/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../../tempoxyz/gateway/node_modules/.pnpm/wrangler@4.152.0_@types+node@26.6.5/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-6YEFcK/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
