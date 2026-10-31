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

pub enum Failure {
    Configuration(String),
    Unavailable(String),
}

pub async fn tools(servers: Vec<Server>) -> Result<Vec<PreparedMcpTool>, Failure> {
    if servers.is_empty() {
        return Ok(Vec::new());
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
        builder = builder.server(server.name, config);
    }
    let mcp = builder
        .build()
        .map_err(|error| Failure::Configuration(error.to_string()))?;
    let mut tools = Vec::new();
    for (server, prepared) in mcp.prepared_servers(Duration::MAX).await {
        tools.extend(
            prepared
                .map_err(|error| Failure::Unavailable(format!("MCP server {server}: {error}")))?,
        );
    }
    Ok(tools)
}
