use std::sync::Arc;

use nanocode::{FunctionHandler, FunctionTool, tool_contract::ToolContext};
use nanocode_code_mode::embedded::HostFuture;
use serde::Deserialize;
use serde_json::{Value, json};

use super::bridge::call;

#[derive(Deserialize)]
pub struct HostTool {
    name: String,
    description: String,
    parameters: Value,
    #[serde(default)]
    content: bool,
}

struct Bridge;

impl FunctionHandler for Bridge {
    fn call<'a>(
        &'a self,
        name: &'a str,
        input: Value,
        context: ToolContext<'a>,
    ) -> HostFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            call(json!({"op": "tool_call", "name": name, "input": input, "call_id": context.call_id()}))
                .await
                .map_err(|error| {
                    error
                        .get("detail")
                        .and_then(Value::as_str)
                        .map_or_else(|| error.to_string(), str::to_owned)
                })
        })
    }
}

pub fn tools(definitions: Vec<HostTool>) -> impl Iterator<Item = FunctionTool> {
    let bridge: Arc<dyn FunctionHandler> = Arc::new(Bridge);
    definitions.into_iter().map(move |tool| {
        FunctionTool::new(
            tool.name,
            tool.description,
            tool.parameters,
            Arc::clone(&bridge),
        )
        .parallel_tool_calls(true)
        .content_results(tool.content)
    })
}
