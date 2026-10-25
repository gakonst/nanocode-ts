use std::sync::Arc;

use nanocode::{FunctionHandler, FunctionTool, Tool, tool_contract::ToolContext};
use nanocode_code_mode::{
    code_mode::{LocalCells, bytes},
    embedded::HostFuture,
};
use serde_json::{Value, json};

use super::bridge::{call, call_bytes_with, call_framed, call_with_body};

const PRELUDE: &str = include_str!("prelude.js");

const LAZY: [(&str, &str); 4] = [
    ("crypto", include_str!("prelude/crypto.js")),
    ("extra", include_str!("prelude/extra.js")),
    ("intl", include_str!("prelude/intl.js")),
    ("web", include_str!("prelude/web.js")),
];

fn prelude() -> String {
    let sources = LAZY
        .iter()
        .map(|(name, source)| {
            format!(
                "{name}: function () {{/*{}*/}}",
                source.replace("*/", "*\u{1}/")
            )
        })
        .collect::<Vec<_>>()
        .join(",\n");
    format!("const lazySources = {{\n{sources}\n}};\n{PRELUDE}")
}

pub fn host(workspace: Option<&str>) -> LocalCells {
    LocalCells::new().prelude(prelude()).host_tools(
        tools(workspace)
            .into_iter()
            .map(|tool| Arc::new(tool) as Arc<dyn Tool>),
    )
}

struct Fetch;

struct Shell(String);

struct File(String);

struct Wasm;

fn failure(error: Value) -> String {
    error
        .get("detail")
        .and_then(Value::as_str)
        .map_or_else(|| error.to_string(), str::to_owned)
}

impl FunctionHandler for Fetch {
    fn call<'a>(
        &'a self,
        _name: &'a str,
        input: Value,
        _context: ToolContext<'a>,
    ) -> HostFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let mut input = input;
            let body = match input
                .as_object_mut()
                .and_then(|fields| fields.remove("body_ref"))
            {
                Some(id) => Some(
                    id.as_u64()
                        .and_then(bytes::take)
                        .ok_or("the fetch body is gone")?,
                ),
                None => None,
            };
            let (mut head, body) = call_framed(
                json!({"op": "cell_fetch", "request": input}),
                body.as_deref(),
            )
            .await
            .map_err(failure)?;
            head["body_ref"] = bytes::put(body).into();
            Ok(head)
        })
    }
}

impl FunctionHandler for Shell {
    fn call<'a>(
        &'a self,
        _name: &'a str,
        input: Value,
        _context: ToolContext<'a>,
    ) -> HostFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let script = input
                .get("script")
                .and_then(Value::as_str)
                .ok_or("bash expects { script }")?;
            call(json!({
                "op": "shell_run",
                "command": script,
                "cwd": self.0,
                "timeout_ms": input.get("timeout_ms").and_then(Value::as_u64),
                "stdin": input.get("stdin").and_then(Value::as_str),
            }))
            .await
            .map_err(failure)
        })
    }
}

impl FunctionHandler for File {
    fn call<'a>(
        &'a self,
        _name: &'a str,
        input: Value,
        _context: ToolContext<'a>,
    ) -> HostFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let path = input
                .get("path")
                .and_then(Value::as_str)
                .ok_or("file expects { op, path }")?;
            match input.get("op").and_then(Value::as_str) {
                Some("read") => {
                    let data =
                        call_bytes_with(&json!({"op": "cell_read", "path": path, "cwd": self.0}))
                            .await
                            .map_err(failure)?;
                    Ok(json!({"bytes_ref": bytes::put(data)}))
                }
                Some(op @ ("write" | "append")) => {
                    let data = input
                        .get("bytes_ref")
                        .and_then(Value::as_u64)
                        .and_then(bytes::take)
                        .ok_or("the file data is gone")?;
                    call_with_body(
                        json!({"op": "cell_write", "path": path, "cwd": self.0, "append": op == "append"}),
                        &data,
                    )
                    .await
                    .map_err(failure)
                }
                _ => Err("file expects op read, write or append".to_owned()),
            }
        })
    }
}

impl FunctionHandler for Wasm {
    fn call<'a>(
        &'a self,
        _name: &'a str,
        input: Value,
        _context: ToolContext<'a>,
    ) -> HostFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let mut input = input;
            match input
                .as_object_mut()
                .and_then(|fields| fields.remove("module_ref"))
            {
                Some(id) => {
                    let module = id
                        .as_u64()
                        .and_then(bytes::take)
                        .ok_or("the module bytes are gone")?;
                    call_with_body(json!({"op": "cell_wasm", "request": input}), &module).await
                }
                None => call(json!({"op": "cell_wasm", "request": input})).await,
            }
            .map_err(failure)
        })
    }
}

fn tools(workspace: Option<&str>) -> Vec<FunctionTool> {
    let fetch = FunctionTool::new(
        "fetch",
        "Make an HTTP request from this host, which may pay for it.",
        json!({
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "method": {"type": "string"},
                "headers": {"type": "object", "additionalProperties": {"type": "string"}},
                "body": {"type": "string"},
                "body_ref": {"type": "integer"}
            },
            "required": ["url"],
            "additionalProperties": false
        }),
        Arc::new(Fetch),
    )
    .parallel_tool_calls(true);
    let shell = workspace.map(|root| {
        FunctionTool::new(
            "bash",
            "Run a bash script in this session's simulated shell over its files.",
            json!({
                "type": "object",
                "properties": {
                    "script": {"type": "string"},
                    "stdin": {"type": "string"},
                    "timeout_ms": {"type": "integer"}
                },
                "required": ["script"],
                "additionalProperties": false
            }),
            Arc::new(Shell(root.to_owned())),
        )
    });
    let file = workspace.map(|root| {
        FunctionTool::new(
            "file",
            "Read, write or append one file of this session's workspace as bytes.",
            json!({
                "type": "object",
                "properties": {
                    "op": {"type": "string", "enum": ["read", "write", "append"]},
                    "path": {"type": "string"},
                    "bytes_ref": {"type": "integer"}
                },
                "required": ["op", "path"],
                "additionalProperties": false
            }),
            Arc::new(File(root.to_owned())),
        )
    });
    let wasm = workspace.map(|_| {
        FunctionTool::new(
            "wasm",
            "Run, instantiate or call WebAssembly modules in this host.",
            json!({
                "type": "object",
                "properties": {
                    "op": {"type": "string"},
                    "module": {"type": "string"},
                    "module_ref": {"type": "integer"},
                    "path": {"type": "string"},
                    "args": {"type": "array"},
                    "stdin": {"type": "string"},
                    "env": {"type": "object"},
                    "id": {"type": "integer"},
                    "name": {"type": "string"},
                    "offset": {"type": "integer"},
                    "length": {"type": "integer"},
                    "data": {"type": "string"},
                    "pages": {"type": "integer"}
                },
                "required": ["op"],
                "additionalProperties": false
            }),
            Arc::new(Wasm),
        )
    });
    [Some(fetch), shell, file, wasm]
        .into_iter()
        .flatten()
        .collect()
}
