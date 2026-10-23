use std::sync::Arc;

use nanocode::{FunctionHandler, FunctionTool, tool_contract::ToolContext};
use nanocode_code_mode::{code_mode::LocalCells, embedded::HostFuture};
use serde_json::{Value, json};

use super::bridge::call;

const PRELUDE: &str = include_str!("prelude.js");

pub fn host() -> LocalCells {
    LocalCells::new().prelude(PRELUDE)
}

struct Fetch;

struct Shell(String);

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

pub fn tools(workspace: Option<&str>) -> Vec<FunctionTool> {
    let fetch = FunctionTool::new(
        "fetch",
        "Make an HTTP request from this host, which may pay for it. Scripts should call the global fetch(url, init) instead: it wraps this tool and returns a Response-like object with ok, status, headers.get, text(), json() and arrayBuffer().",
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
            "Run a bash script in this session's simulated shell over its files (no real processes). Returns { stdout, stderr, exit_code }. Scripts should call the global bash instead: bash(script) or a tagged template such as bash`ls ${dir}` resolve to { stdout, stderr, exitCode }, and bash.readFile(path) and bash.writeFile(path, text) read and write files.",
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
    [Some(fetch), shell].into_iter().flatten().collect()
}
