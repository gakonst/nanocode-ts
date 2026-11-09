use std::{collections::BTreeMap, sync::Arc, time::Duration};

use nanocode::{
    http::{BoxFuture, Error, Request, Response, Sender, origin},
    tools::mcp::{Mcp, McpServer, PreparedMcpTool},
};
use serde::Deserialize;

use super::transport::WorkerTransport;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Server {
    name: String,
    url: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    bearer_token: Option<String>,
    #[serde(default)]
    tool_timeout_ms: Option<u64>,
}

struct McpTransport;

impl Sender for McpTransport {
    fn send(&self, request: Request) -> BoxFuture<'_, Result<Response, Error>> {
        let origin = origin::Origin {
            context: None,
            session: caller(&request.body),
        };
        Box::pin(origin.scope(WorkerTransport::MCP.send(request)))
    }
}

fn caller(body: &[u8]) -> Option<Arc<str>> {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()?
        .pointer("/params/_meta/x-codex-turn-metadata/session_id")?
        .as_str()
        .map(Arc::from)
}

#[derive(Default)]
pub struct Prepared {
    pub tools: Vec<PreparedMcpTool>,
    pub unavailable: Vec<String>,
}

pub async fn tools(servers: Vec<Server>) -> Result<Prepared, String> {
    let mut prepared = Prepared::default();
    if servers.is_empty() {
        return Ok(prepared);
    }
    let mut builder = Mcp::builder().http_sender(Arc::new(McpTransport));
    for server in servers {
        let mut config = McpServer::http(server.url);
        if let Some(token) = server.bearer_token {
            config = config.bearer_token(token);
        }
        for (name, value) in server.headers {
            config = config.header(name, value);
        }
        if let Some(milliseconds) = server.tool_timeout_ms {
            config = config.tool_timeout(Duration::from_millis(milliseconds));
        }
        builder = builder.server(server.name, config);
    }
    let mcp = builder.build().map_err(|error| error.to_string())?;
    for (server, result) in mcp.prepared_servers(Duration::MAX).await {
        match result {
            Ok(tools) => prepared.tools.extend(tools),
            Err(error) => {
                let message = format!("MCP server {server}: {error}");
                tracing::warn!(%message, "MCP server is unavailable; its tools are left out");
                prepared.unavailable.push(message);
            }
        }
    }
    Ok(prepared)
}
