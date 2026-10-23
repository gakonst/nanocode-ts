use std::sync::Arc;

use nanocode::{FunctionHandler, FunctionTool, Tool, tool_contract::ToolContext};
use nanocode_code_mode::{code_mode::LocalCells, embedded::HostFuture};
use serde_json::{Value, json};

use super::bridge::call;

const PRELUDE: &str = include_str!("prelude.js");

pub fn host(workspace: Option<&str>) -> LocalCells {
    LocalCells::new().prelude(PRELUDE).host_tools(
        tools(workspace)
            .into_iter()
            .map(|tool| Arc::new(tool) as Arc<dyn Tool>),
    )
}

struct Fetch;

struct Shell(String);

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
            call(json!({"op": "cell_fetch", "request": input}))
                .await
                .map_err(failure)
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
                "timeout_ms": null,
                "stdin": input.get("stdin").and_then(Value::as_str),
            }))
            .await
            .map_err(failure)
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
            call(json!({"op": "cell_wasm", "request": input}))
                .await
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
                "body_base64": {"type": "string"}
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
                    "stdin": {"type": "string"}
                },
                "required": ["script"],
                "additionalProperties": false
            }),
            Arc::new(Shell(root.to_owned())),
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
    [Some(fetch), shell, wasm].into_iter().flatten().collect()
}
