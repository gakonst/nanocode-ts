use std::{cell::RefCell, sync::Arc};

use nanocode::{Tool, tool_contract::ToolInput};
use nanocode_code_mode::{
    ToolDefinition, ToolOutput,
    code_mode::{CodeModeExecution, CodeModeObserver, LocalCells},
    embedded::{CodeModeHost, CodeModeHostError, HostFuture, OwnedToolContext},
    remote::{
        DetachedObservers, ExecutorOptions, HandActivity, HandBrain, HandCapability, HandCore,
        HandEnvironment, HandHost, HandPermission, HandSession, RemoteFrame as Frame,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{
    bridge::{call, spawn},
    cells, mcp, tools, workspace,
};

const DEFAULT_MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

struct Open {
    core: HandCore,
    limit: usize,
    connection: Option<u64>,
}

thread_local! {
    static HAND: RefCell<Option<Open>> = const { RefCell::new(None) };
}

#[derive(Clone, Deserialize)]
pub struct CapabilitySpec {
    name: String,
    description: String,
    #[serde(default)]
    tools: Vec<String>,
}

pub struct Opening {
    pub name: Option<String>,
    pub workspace: Option<String>,
    pub max_frame_bytes: Option<usize>,
    pub runtime_id: Option<String>,
    pub host_tools: Vec<tools::HostTool>,
    pub mcp_servers: Vec<mcp::Server>,
    pub environment: Option<HandEnvironment>,
    pub capabilities: Vec<CapabilitySpec>,
    pub tools_only: bool,
}

struct Host {
    cells: Arc<LocalCells>,
    own: Vec<Arc<dyn Tool>>,
    workspace: Option<String>,
    environment: Option<HandEnvironment>,
    capabilities: Vec<CapabilitySpec>,
    tools_only: bool,
}

impl HandHost for Host {
    fn definitions(&self) -> HostFuture<'_, Vec<ToolDefinition>> {
        let definitions = self.own.iter().map(|tool| tool.definition()).collect();
        Box::pin(async move { definitions })
    }

    fn workspace(&self) -> Option<String> {
        self.workspace.clone()
    }

    fn selects_tools(&self) -> bool {
        true
    }

    fn open(
        &self,
        session_id: &str,
        excluded: Vec<String>,
        brain: HandBrain,
    ) -> Result<Arc<dyn HandSession>, CodeModeHostError> {
        let own = self
            .own
            .iter()
            .filter(|tool| !excluded.iter().any(|name| name == tool.definition().name()))
            .cloned()
            .collect();
        Ok(Arc::new(Session {
            cells: Arc::clone(&self.cells),
            session_id: session_id.to_owned(),
            own,
            brain,
        }))
    }

    fn end_turn<'a>(
        &'a self,
        session_id: &'a str,
        turn_id: &'a str,
        hook_event_name: &'a str,
    ) -> HostFuture<'a, ()> {
        Box::pin(async move {
            for tool in &self.own {
                if let Err(issue) = tool.end_turn(session_id, turn_id, hook_event_name).await {
                    tracing::warn!(%issue, "hand tool turn cleanup failed; not retried");
                }
            }
        })
    }

    fn spawn(&self, task: HostFuture<'static, ()>) {
        spawn(task);
    }

    fn environment(&self) -> Option<HandEnvironment> {
        self.environment.clone()
    }

    fn runs_cells(&self) -> bool {
        !self.tools_only
    }

    fn capabilities(&self) -> HostFuture<'_, Vec<HandCapability>> {
        Box::pin(async move {
            if self.capabilities.is_empty() {
                return Vec::new();
            }
            match call(json!({"op": "hand_capabilities"})).await {
                Ok(value) => serde_json::from_value(value).unwrap_or_default(),
                Err(_) => self
                    .capabilities
                    .iter()
                    .map(|spec| HandCapability {
                        name: spec.name.clone(),
                        description: spec.description.clone(),
                        tools: spec.tools.clone(),
                        permission: HandPermission::Prompt,
                    })
                    .collect(),
            }
        })
    }

    fn request_capability<'a>(
        &'a self,
        name: &'a str,
        reason: &'a str,
    ) -> HostFuture<'a, Result<HandPermission, String>> {
        Box::pin(async move {
            let value =
                call(json!({"op": "hand_request_capability", "name": name, "reason": reason}))
                    .await
                    .map_err(|issue| issue.to_string())?;
            serde_json::from_value(value).map_err(|issue| issue.to_string())
        })
    }
}

struct Session {
    cells: Arc<LocalCells>,
    session_id: String,
    own: Vec<Arc<dyn Tool>>,
    brain: HandBrain,
}

impl HandSession for Session {
    fn execute<'a>(
        &'a self,
        source: &'a str,
        context: OwnedToolContext,
        observer: &'a mut dyn CodeModeObserver,
    ) -> HostFuture<'a, Result<CodeModeExecution, CodeModeHostError>> {
        Box::pin(async move {
            let mut tools = self.own.clone();
            tools.extend(
                self.brain
                    .tools(&context.call_id)
                    .into_iter()
                    .filter(|tool| !self.own.iter().any(|own| own.definition().name() == tool.definition().name())),
            );
            self.cells
                .execute_with_local_tools(source, context.as_context(), tools, Some(observer))
                .await
        })
    }

    fn wait<'a>(
        &'a self,
        input: &'a str,
        context: OwnedToolContext,
        observer: &'a mut dyn CodeModeObserver,
    ) -> HostFuture<'a, Result<CodeModeExecution, CodeModeHostError>> {
        Box::pin(async move {
            self.cells
                .wait_with_updates(input, context.as_context(), observer)
                .await
        })
    }

    fn call<'a>(
        &'a self,
        name: &'a str,
        input: Value,
        context: OwnedToolContext,
    ) -> HostFuture<'a, ToolOutput> {
        Box::pin(async move {
            let Some(tool) = self.own.iter().find(|tool| tool.definition().name() == name) else {
                return ToolOutput::error(format!("this browser hand has no tool `{name}`"));
            };
            let raw = match serde_json::value::to_raw_value(&input) {
                Ok(raw) => raw,
                Err(error) => return ToolOutput::error(error.to_string()),
            };
            tool.execute(ToolInput::Function(raw), context.as_context())
                .await
                .unwrap_or_else(|error| ToolOutput::error(error.to_string()))
        })
    }

    fn cancel<'a>(&'a self, observer: &'a mut dyn CodeModeObserver) -> HostFuture<'a, ()> {
        Box::pin(async move {
            let _ = self.cells.cancel_with_updates(&self.session_id, observer).await;
        })
    }

    fn cancel_turn<'a>(&'a self, observer: &'a mut dyn CodeModeObserver) -> HostFuture<'a, ()> {
        Box::pin(async move {
            let _ = self
                .cells
                .cancel_turn_with_updates(&self.session_id, observer)
                .await;
        })
    }

    fn detach_turn<'a>(&'a self, observers: DetachedObservers<'a>) -> HostFuture<'a, ()> {
        self.cells.detach_turn(&self.session_id, observers);
        Box::pin(async {})
    }

    fn begin_turn(&self) {
        self.cells.begin_turn(&self.session_id);
    }

    fn preempt(&self) -> HostFuture<'_, ()> {
        Box::pin(async move {
            let _ = self.cells.preempt_turn(&self.session_id).await;
        })
    }

    fn settle_preempt(&self) {
        self.cells.settle_preempt(&self.session_id);
    }

    fn close(&self) -> HostFuture<'_, ()> {
        Box::pin(async move {
            let _ = CodeModeHost::cancel(&*self.cells, &self.session_id).await;
        })
    }
}

fn open() -> Result<(HandCore, usize), String> {
    HAND.with_borrow(|hand| {
        hand.as_ref()
            .map(|open| (open.core.clone(), open.limit))
            .ok_or_else(|| "the hand is not open".to_owned())
    })
}

pub async fn open_hand(opening: Opening) -> Result<Value, String> {
    let Opening {
        name,
        workspace,
        max_frame_bytes,
        runtime_id,
        host_tools,
        mcp_servers,
        environment,
        capabilities,
        tools_only,
    } = opening;
    let limit = max_frame_bytes.unwrap_or(DEFAULT_MAX_FRAME_BYTES);
    let mut own: Vec<Arc<dyn Tool>> = Vec::new();
    if let Some(root) = workspace.as_deref() {
        let codex = nanocode::codex_tools::host_tools(
            root.into(),
            Arc::new(workspace::HostFiles),
            Arc::new(workspace::HostShell),
        )
        .map_err(|error| error.to_string())?;
        let claude = nanocode::claude::host_tools(
            root.into(),
            Arc::new(workspace::HostFiles),
            Arc::new(workspace::HostShell),
        )
        .map_err(|error| error.to_string())?;
        own.extend(
            codex
                .registered_tools()
                .chain(claude.registered_tools())
                .filter(|tool| tool.definition().name() != "update_plan")
                .cloned(),
        );
    }
    own.extend(tools::tools(host_tools).map(|tool| Arc::new(tool) as Arc<dyn Tool>));
    own.extend(
        mcp::tools(mcp_servers)
            .await
            .map_err(|failure| match failure {
                mcp::Failure::Configuration(error) | mcp::Failure::Unavailable(error) => error,
            })?
            .into_iter()
            .map(|tool| Arc::new(tool) as Arc<dyn Tool>),
    );
    let host = Host {
        cells: Arc::new(cells::host(workspace.as_deref())),
        own,
        workspace,
        environment,
        capabilities,
        tools_only,
    };
    let options = ExecutorOptions {
        name,
        runtime_id,
        ..ExecutorOptions::default()
    };
    let (core, driver) = HandCore::new(Arc::new(host), options, HandActivity::default());
    spawn(driver);
    let catalog = core.catalog(limit).await.map_err(|error| error.to_string())?;
    HAND.set(Some(Open {
        core,
        limit,
        connection: None,
    }));
    Ok(Value::String(catalog))
}

pub async fn connect() -> Result<Value, String> {
    let (core, limit) = open()?;
    let catalog = core.catalog(limit).await.map_err(|error| error.to_string())?;
    let (wire, mut frames) = mpsc::unbounded_channel::<String>();
    let connection = core.connect(wire, limit);
    let id = connection.id;
    HAND.with_borrow_mut(|hand| {
        if let Some(open) = hand.as_mut() {
            open.connection = Some(id);
        }
    });
    spawn(async move {
        while let Some(text) = frames.recv().await {
            let _ = call(json!({"op": "hand_send", "text": text, "connection": id})).await;
        }
    });
    let failed = connection.failed;
    spawn(async move {
        if let Ok(issue) = failed.await {
            let _ = call(json!({"op": "hand_failed", "reason": issue.to_string(), "connection": id})).await;
        }
    });
    Ok(json!({"catalog": catalog, "connection": id}))
}

pub fn receive(text: &str) -> Result<Value, String> {
    let (core, limit) = open()?;
    let connection = HAND
        .with_borrow(|hand| hand.as_ref().and_then(|open| open.connection))
        .ok_or("the hand has no connection")?;
    let frame = Frame::decode(text, limit).map_err(|error| error.to_string())?;
    core.receive(connection, frame);
    Ok(Value::Null)
}

pub async fn closed() -> Result<Value, String> {
    let Ok((core, _)) = open() else {
        return Ok(Value::Null);
    };
    let connection = HAND.with_borrow_mut(|hand| hand.as_mut().and_then(|open| open.connection.take()));
    if let Some(connection) = connection {
        core.closed(connection).await;
    }
    Ok(Value::Null)
}

