use std::sync::Arc;

use nanocode::{
    ChildHost, ChildSpec, NanocodeError, TurnResult,
    backend::{BackendFuture, Prompt, PromptInput},
    tool_contract::{Tool, ToolContext, ToolDefinition, ToolOutput, ToolOutputWire, ToolResult},
};
use nanocode_code_mode::embedded::HostFuture;
use serde_json::{Value, json};

use super::bridge::call;

pub struct HostChildren;

fn failed(value: &Value) -> NanocodeError {
    let detail = value
        .get("detail")
        .and_then(Value::as_str)
        .map_or_else(|| value.to_string(), str::to_owned);
    NanocodeError::Backend {
        backend: "remote_child",
        source: Arc::new(std::io::Error::other(detail)),
    }
}

fn prompt_text(prompt: &Prompt) -> nanocode::agent::Result<String> {
    match &prompt.instruction {
        PromptInput::Text(text) => Ok(text.clone()),
        PromptInput::Content(_) => Err(NanocodeError::UnsupportedCapability {
            capability: "remote_child_content_prompt",
        }),
    }
}

async fn send(request: Value) -> nanocode::agent::Result<Value> {
    call(request).await.map_err(|error| failed(&error))
}

impl ChildHost for HostChildren {
    fn cancel(
        &self,
        session_id: Arc<str>,
        request_id: Option<String>,
    ) -> BackendFuture<nanocode::agent::Result<()>> {
        Box::pin(async move {
            send(json!({"op": "child_cancel", "session_id": session_id, "request_id": request_id}))
                .await
                .map(drop)
        })
    }

    fn close(&self, session_id: Arc<str>) -> BackendFuture<nanocode::agent::Result<()>> {
        Box::pin(async move {
            send(json!({"op": "child_close", "session_id": session_id}))
                .await
                .map(drop)
        })
    }

    fn open(&self, child: ChildSpec) -> BackendFuture<nanocode::agent::Result<()>> {
        Box::pin(async move {
            let tools = child
                .tools
                .iter()
                .map(|definition| match definition {
                    ToolDefinition::Function {
                        name,
                        description,
                        parameters,
                        ..
                    } => Ok(json!({
                        "name": name,
                        "description": description,
                        "parameters": parameters,
                        "wire": true,
                    })),
                    _ => Err(NanocodeError::UnsupportedCapability {
                        capability: "remote_child_tool_kind",
                    }),
                })
                .collect::<nanocode::agent::Result<Vec<_>>>()?;
            send(json!({
                "op": "child_open",
                "session_id": child.session_id,
                "lineage": child.lineage,
                "model": child.model.as_str(),
                "thinking": child.thinking,
                "restored": child.restored,
                "origin": child.host_context.as_deref(),
                "tools": tools,
            }))
            .await
            .map(drop)
        })
    }

    fn pending(
        &self,
        session_id: Arc<str>,
    ) -> BackendFuture<nanocode::agent::Result<Option<(String, Value)>>> {
        Box::pin(async move {
            let reply = send(json!({"op": "child_pending", "session_id": session_id})).await?;
            let (Some(request_id), Some(text)) = (
                reply.get("request_id").and_then(Value::as_str),
                reply.get("prompt").and_then(Value::as_str),
            ) else {
                return Ok(None);
            };
            let prompt = Prompt::from(text);
            let prompt = match reply.get("instruction_revision").and_then(Value::as_u64) {
                Some(revision) => prompt.with_instruction_revision(revision),
                None => prompt,
            };
            let input =
                serde_json::to_value(prompt).map_err(|error| failed(&json!(error.to_string())))?;
            Ok(Some((request_id.to_owned(), input)))
        })
    }

    fn run(
        &self,
        session_id: Arc<str>,
        request_id: String,
        prompt: Prompt,
    ) -> BackendFuture<nanocode::agent::Result<TurnResult>> {
        Box::pin(async move {
            let text = prompt_text(&prompt)?;
            let reply = send(json!({
                "op": "child_run",
                "session_id": session_id,
                "request_id": request_id,
                "prompt": text,
                "instruction_revision": prompt.instruction_revision(),
            }))
            .await?;
            let usage = reply
                .get("usage")
                .filter(|usage| !usage.is_null())
                .cloned()
                .map(serde_json::from_value::<nanocode::TurnUsage>)
                .transpose()
                .map_err(|error| failed(&json!(error.to_string())))?;
            let field = |name: &str| reply.get(name).and_then(Value::as_str).map(str::to_owned);
            match reply.get("status").and_then(Value::as_str) {
                Some("completed") => Ok(TurnResult {
                    request_id: Some(request_id),
                    turn_id: field("turn_id"),
                    final_message: field("final_message").unwrap_or_default(),
                    usage,
                    boundary: None,
                }),
                Some("cancelled") => Err(NanocodeError::TurnCancelled),
                _ => Err(failed(&reply)),
            }
        })
    }

    fn steer(
        &self,
        session_id: Arc<str>,
        request_id: String,
        id: Option<String>,
        prompt: Prompt,
    ) -> BackendFuture<nanocode::agent::Result<()>> {
        Box::pin(async move {
            let text = prompt_text(&prompt)?;
            let reply = send(json!({
                "op": "child_steer",
                "session_id": session_id,
                "request_id": request_id,
                "id": id,
                "prompt": text,
                "instruction_revision": prompt.instruction_revision(),
            }))
            .await?;
            if reply.get("steered").and_then(Value::as_bool) == Some(true) {
                Ok(())
            } else {
                Err(NanocodeError::TurnNotSteerable)
            }
        })
    }
}

pub struct WireTool {
    definition: ToolDefinition,
}

impl WireTool {
    pub fn new(name: String, description: String, parameters: Value) -> Self {
        Self {
            definition: ToolDefinition::function(name.as_str(), description.as_str(), parameters),
        }
    }
}

impl Tool for WireTool {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    fn execute<'life0, 'life1, 'async_trait>(
        &'life0 self,
        input: nanocode::tool_contract::ToolInput,
        context: ToolContext<'life1>,
    ) -> HostFuture<'async_trait, ToolResult>
    where
        'life0: 'async_trait,
        'life1: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            let input: Value = match input.decode_json() {
                Ok(input) => input,
                Err(error) => return Ok(ToolOutput::error(error.to_string())),
            };
            let request = json!({
                "op": "child_tool",
                "name": self.definition.name(),
                "input": input,
                "context": {
                    "session_id": context.session_id(),
                    "call_id": context.call_id(),
                    "turn_id": context.turn_id(),
                    "origin": context.host_context(),
                    "instruction_revision": context.instruction_revision(),
                    "output_token_budget": context.output_token_budget(),
                },
            });
            Ok(match call(request).await {
                Ok(wire) => serde_json::from_value::<ToolOutputWire>(wire)
                    .and_then(ToolOutput::from_wire)
                    .unwrap_or_else(|error| ToolOutput::error(error.to_string())),
                Err(error) => ToolOutput::error(failed(&error).to_string()),
            })
        })
    }
}
