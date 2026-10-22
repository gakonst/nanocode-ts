use std::{collections::BTreeMap, sync::Arc, time::Duration};

use nanocode::tools::mcp::{Mcp, McpServer, PreparedMcpTool};
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

pub enum Failure {
    Configuration(String),
    Unavailable(String),
}

pub async fn tools(servers: Vec<Server>) -> Result<Vec<PreparedMcpTool>, Failure> {
    if servers.is_empty() {
        return Ok(Vec::new());
    }
    let mut builder = Mcp::builder().http_sender(Arc::new(WorkerTransport));
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
