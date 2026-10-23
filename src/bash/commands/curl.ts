import { CommandError, type CommandHandler } from "../shell.ts";
import { decode, encode } from "../fs.ts";
import { escapes } from "../text.ts";

const VALUES = new Set(["-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json", "-o", "--output", "-w", "--write-out", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-m", "--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "-F", "--form", "--url", "-T", "--upload-file", "--max-redirs", "-x", "--proxy", "-c", "--cookie-jar", "--resolve", "--cacert", "--cert", "--key", "-r", "--range", "--oauth2-bearer"]);

const FLAGS: Record<string, string> = { s: "--silent", S: "--show-error", i: "--include", I: "--head", L: "--location", f: "--fail", v: "--verbose", k: "--insecure", G: "--get", O: "--remote-name", g: "--globoff", N: "--no-buffer", n: "--netrc", q: "--disable", "#": "--progress-bar", Z: "--parallel" };

const SHORT_VALUES = "XHdowuAebmFTrxc";

export const curl: CommandHandler = async ctx => {
  const flags = new Set<string>();
  const values: [string, string][] = [];
  const urls: string[] = [];
  const args = ctx.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      if (VALUES.has(name)) {
        const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
        if (value === undefined) throw new CommandError("option " + name + ": requires parameter", 2);
        values.push([name, value]);
      } else flags.add(name);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j];
        if (SHORT_VALUES.includes(c)) {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
          if (value === undefined) throw new CommandError("option -" + c + ": requires parameter", 2);
          values.push(["-" + c, value]);
          break;
        }
        if (!FLAGS[c]) throw new CommandError("option -" + c + ": is unknown", 2);
        flags.add(FLAGS[c]);
      }
      continue;
    }
    urls.push(arg);
  }
  const get = (...names: string[]) => values.filter(([name]) => names.includes(name)).map(([, value]) => value);
  urls.push(...get("--url"));
  const silent = flags.has("--silent") && !flags.has("--show-error");
  const fail = (code: number, message: string) => {
    if (!silent) ctx.stderr.write("curl: (" + code + ") " + message + "\n");
    return code;
  };
  if (!urls.length) return fail(2, "no URL specified");
  if (!ctx.fetch) return fail(7, "network access is not available in this shell");
  const headers = new Headers();
  for (const header of get("-H", "--header")) {
    const colon = header.indexOf(":");
    if (colon < 0) {
      if (header.endsWith(";")) headers.set(header.slice(0, -1), "");
      continue;
    }
    const value = header.slice(colon + 1).trim();
    if (value === "") headers.delete(header.slice(0, colon).trim());
    else headers.append(header.slice(0, colon).trim(), value);
  }
  const user = get("-u", "--user")[0];
  if (user !== undefined) headers.set("authorization", "Basic " + btoa(user));
  const bearer = get("--oauth2-bearer")[0];
  if (bearer !== undefined) headers.set("authorization", "Bearer " + bearer);
  const agent = get("-A", "--user-agent")[0];
  headers.set("user-agent", agent ?? headers.get("user-agent") ?? "curl/8.5.0");
  const referer = get("-e", "--referer")[0];
  if (referer !== undefined) headers.set("referer", referer);
  const cookie = get("-b", "--cookie")[0];
  if (cookie !== undefined && cookie.includes("=")) headers.set("cookie", cookie);
  const readData = async (value: string, binary: boolean) => {
    if (!value.startsWith("@")) return value;
    const file = value.slice(1);
    const text = file === "-" ? ctx.stdin.read() : decode(await ctx.fs.read(ctx.resolve(file)));
    return binary ? text : text.replace(/[\r\n]/g, "");
  };
  const data: string[] = [];
  for (const [name, value] of values) {
    if (name === "-d" || name === "--data" || name === "--data-ascii") data.push(await readData(value, false));
    else if (name === "--data-binary") data.push(await readData(value, true));
    else if (name === "--data-raw") data.push(value);
    else if (name === "--data-urlencode") {
      const eq = value.indexOf("=");
      if (eq < 0) data.push(encodeURIComponent(await readData(value, true)));
      else data.push(value.slice(0, eq + 1) + encodeURIComponent(await readData(value.slice(eq + 1), true)));
    } else if (name === "--json") {
      data.push(await readData(value, true));
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      if (!headers.has("accept")) headers.set("accept", "application/json");
    }
  }
  const forms = get("-F", "--form");
  let body: BodyInit | undefined;
  let method = get("-X", "--request")[0];
  let url = urls[0];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "http://" + url;
  if (flags.has("--get") && data.length) {
    url += (url.includes("?") ? "&" : "?") + data.join("&");
  } else if (forms.length) {
    const form = new FormData();
    for (const field of forms) {
      const eq = field.indexOf("=");
      if (eq < 0) throw new CommandError("illegally formatted input field", 2);
      const key = field.slice(0, eq);
      const value = field.slice(eq + 1);
      if (value.startsWith("@")) {
        const path = value.slice(1).split(";")[0];
        form.append(key, new Blob([(await ctx.fs.read(ctx.resolve(path))) as Uint8Array<ArrayBuffer>]), path.slice(path.lastIndexOf("/") + 1));
      } else form.append(key, value);
    }
    body = form;
    method ??= "POST";
  } else if (data.length) {
    body = data.join("&");
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded");
    method ??= "POST";
  }
  const upload = get("-T", "--upload-file")[0];
  if (upload !== undefined) {
    body = (await ctx.fs.read(ctx.resolve(upload))) as Uint8Array<ArrayBuffer>;
    method ??= "PUT";
  }
  if (flags.has("--head")) method = "HEAD";
  method ??= "GET";
  const timeout = get("-m", "--max-time")[0];
  const controller = new AbortController();
  const abort = () => controller.abort();
  ctx.signal.addEventListener("abort", abort, { once: true });
  const timer = timeout !== undefined ? setTimeout(() => controller.abort("timeout"), Number(timeout) * 1000) : undefined;
  const started = Date.now();
  const verbose = flags.has("--verbose");
  if (verbose) {
    ctx.stderr.write("> " + method + " " + url + "\n");
    headers.forEach((value, key) => ctx.stderr.write("> " + key + ": " + value + "\n"));
    ctx.stderr.write(">\n");
  }
  let response: Response;
  try {
    response = await ctx.fetch(url, { method, headers, body, redirect: flags.has("--location") ? "follow" : "manual", signal: controller.signal });
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer);
    ctx.signal.removeEventListener("abort", abort);
    if (controller.signal.reason === "timeout") return fail(28, "Operation timed out after " + (Date.now() - started) + " milliseconds");
    if (ctx.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return fail(/resolve|ENOTFOUND|getaddrinfo/i.test(message) ? 6 : 7, message);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    ctx.signal.removeEventListener("abort", abort);
  }
  if (bytes.length > ctx.limits.maxBufferLength) throw new CommandError("response exceeded " + ctx.limits.maxBufferLength + " bytes", 63);
  const statusLine = "HTTP/1.1 " + response.status + " " + response.statusText;
  let head = statusLine + "\r\n";
  response.headers.forEach((value, key) => {
    head += key + ": " + value + "\r\n";
  });
  head += "\r\n";
  if (verbose) ctx.stderr.write(head.split("\r\n").filter(Boolean).map(line => "< " + line).join("\n") + "\n<\n");
  const failed = (flags.has("--fail") || flags.has("--fail-with-body")) && response.status >= 400;
  const output = get("-o", "--output")[0] ?? (flags.has("--remote-name") ? new URL(url).pathname.split("/").pop() || "index.html" : undefined);
  if (failed && !flags.has("--fail-with-body")) {
    if (!silent || flags.has("--show-error")) ctx.stderr.write("curl: (22) The requested URL returned error: " + response.status + "\n");
  } else {
    const text = flags.has("--include") || flags.has("--head") ? head : "";
    if (output !== undefined && output !== "-") {
      const combined = new Uint8Array(encode(text).length + bytes.length);
      combined.set(encode(text));
      combined.set(bytes, encode(text).length);
      await ctx.fs.write(ctx.resolve(output), combined);
    } else ctx.stdout.write(text + (method === "HEAD" ? "" : decode(bytes)));
  }
  const writeOut = get("-w", "--write-out")[0];
  if (writeOut !== undefined) {
    const variables: Record<string, string> = {
      http_code: String(response.status),
      response_code: String(response.status),
      content_type: response.headers.get("content-type") ?? "",
      size_download: String(bytes.length),
      url_effective: response.url || url,
      time_total: ((Date.now() - started) / 1000).toFixed(6),
      method,
      num_headers: String([...response.headers.keys()].length),
    };
    const [expanded] = escapes(writeOut);
    ctx.stdout.write(expanded.replace(/%\{([a-z_]+)\}/g, (whole, name: string) => variables[name] ?? whole).replace(/%\{header\{([^}]+)\}\}/g, (_, name: string) => response.headers.get(name) ?? ""));
  }
  return failed ? 22 : 0;
};
