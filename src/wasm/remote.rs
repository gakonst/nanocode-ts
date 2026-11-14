use std::{
    cell::RefCell,
    collections::{BTreeSet, HashMap},
    time::Duration,
};

use std::sync::Arc;

use nanocode_code_mode::{
    Tool,
    embedded::{CodeModeExecution, CodeModeHostError, CodeModeObserver, HandCalls, HostFuture},
    remote::{
        HandToolSelection, NOT_RECEIVED, REQUEST_IN_USE, RemoteActivity, RemoteCatalog,
        RemoteClient, RemoteCodeModeHost, RemoteContext, RemoteDelivery, RemoteFrame as Frame,
        RemoteLink, RemoteOperation, RemoteTransport,
    },
};
use serde_json::{Value, json};

use super::bridge::{call, spawn};

thread_local! {
    static ACTIVITY: RefCell<Vec<RemoteActivity>> = const { RefCell::new(Vec::new()) };
    static ANSWERED: RefCell<BTreeSet<String>> = const { RefCell::new(BTreeSet::new()) };
}

fn error(value: impl std::fmt::Display) -> CodeModeHostError {
    CodeModeHostError::new(value.to_string())
}

fn host_error(value: Value) -> CodeModeHostError {
    match value.get("detail").and_then(Value::as_str) {
        Some(detail) => error(detail),
        None => error(value),
    }
}

fn send_error(value: Value) -> CodeModeHostError {
    if value.get("unsent").and_then(Value::as_bool) == Some(true) {
        CodeModeHostError::unsent(host_error(value).message())
    } else {
        host_error(value)
    }
}

pub fn busy() -> bool {
    ACTIVITY.with_borrow(|activity| activity.iter().any(RemoteActivity::busy))
}

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolSelection {
    include: Option<Vec<String>>,
    #[serde(default)]
    exclude: Vec<String>,
}

pub struct ToolSelections(pub HashMap<String, ToolSelection>);

impl HandToolSelection for ToolSelections {
    fn allows(&self, _session_id: &str, backend: &str, name: &str) -> bool {
        self.0.get(backend).is_none_or(|selection| {
            selection
                .include
                .as_ref()
                .is_none_or(|names| names.iter().any(|allowed| allowed == name))
                && !selection.exclude.iter().any(|excluded| excluded == name)
        })
    }
}

fn context(frame: &Frame) -> Option<&RemoteContext> {
    match frame {
        Frame::Request {
            operation:
                RemoteOperation::Execute { context, .. }
                | RemoteOperation::Wait { context, .. }
                | RemoteOperation::Call { context, .. },
            ..
        } => Some(context),
        _ => None,
    }
}

fn cell(frame: &Frame) -> Option<&str> {
    match frame {
        Frame::Request {
            operation:
                RemoteOperation::Execute { context, .. } | RemoteOperation::Wait { context, .. },
            ..
        } => Some(&context.call_id),
        _ => None,
    }
}

struct WorkerLink {
    connection: Option<String>,
    tool_selection: bool,
    caches_local_tools: bool,
    resumes: Option<String>,
    max_frame_bytes: usize,
    scope: String,
}

async fn commit(scope: &str, cells: &[&str]) -> Result<(), String> {
    let answered = ANSWERED.with_borrow_mut(|scopes| scopes.remove(scope));
    let committed = async {
        let calls = serde_json::value::to_raw_value(cells).map_err(|issue| issue.to_string())?;
        super::log(scope)
            .await?
            .effect("hand", calls)
            .await
            .map(drop)
            .map_err(|issue| issue.to_string())
    }
    .await;
    if committed.is_err() && answered {
        ANSWERED.with_borrow_mut(|scopes| scopes.insert(scope.to_owned()));
    }
    committed
}

pub async fn settle() -> Result<(), String> {
    while let Some(scope) = ANSWERED.with_borrow(|scopes| scopes.first().cloned()) {
        commit(&scope, &[]).await?;
    }
    Ok(())
}

impl RemoteLink for WorkerLink {
    fn supports_tool_selection(&self) -> bool {
        self.tool_selection
    }
    fn caches_local_tools(&self) -> bool {
        self.caches_local_tools
    }
    fn resumes(&self) -> Option<String> {
        self.resumes.clone()
    }
    fn send(
        &self,
        frames: Vec<Frame>,
        delivery: RemoteDelivery,
    ) -> HostFuture<'_, Result<(), CodeModeHostError>> {
        Box::pin(async move {
            let dispatches = frames.iter().any(Frame::dispatches);
            let mut origins = Vec::new();
            for (index, frame) in frames.iter().enumerate() {
                if !frame.dispatches() {
                    continue;
                }
                let context = context(frame);
                let subagent = match context {
                    Some(context) => super::subagent(&context.session_id).await,
                    None => None,
                };
                origins.push(json!({"index": index, "origin": context.and_then(|context| context.host_context.as_deref()), "subagent": subagent}));
            }
            let encoded = frames
                .iter()
                .map(|frame| frame.encode(self.max_frame_bytes))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|issue| CodeModeHostError::unsent(issue.message()))?;
            let cells = frames.iter().filter_map(cell).collect::<Vec<_>>();
            if !cells.is_empty() {
                commit(&self.scope, &cells)
                    .await
                    .map_err(CodeModeHostError::unsent)?;
            }
            let sent = call(json!({"op": "remote_send", "connection": self.connection, "frames": encoded, "durable": delivery == RemoteDelivery::Durable, "dispatches": dispatches, "origins": origins}))
                .await
                .map_err(send_error)?;
            let Some(refused) = sent
                .get("refused")
                .and_then(Value::as_array)
                .filter(|refused| !refused.is_empty())
            else {
                return Ok(());
            };
            let ids = refused
                .iter()
                .map(|index| {
                    match index
                        .as_u64()
                        .and_then(|index| frames.get(usize::try_from(index).ok()?))
                    {
                        Some(Frame::Request { id, .. }) => Ok(*id),
                        _ => Err(error(format!(
                            "the host refused {index}, which is not a request frame of the batch"
                        ))),
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            let reason = sent["reason"]
                .as_str()
                .ok_or_else(|| error("the host refused requests without a reason"))?;
            Err(CodeModeHostError::refused(reason, ids))
        })
    }

    fn receive(&self) -> HostFuture<'_, Result<Vec<Frame>, CodeModeHostError>> {
        Box::pin(async move {
            let value = call(json!({"op": "remote_poll", "connection": self.connection}))
                .await
                .map_err(|issue| {
                    error(format!("runner connection failed: {}", host_error(issue)))
                })?;
            if let Some(reason) = value.get("closed") {
                return Err(error(reason.as_str().unwrap_or("runner disconnected")));
            }
            let frames: Vec<String> =
                serde_json::from_value(value["frames"].clone()).map_err(error)?;
            let frames = frames
                .iter()
                .map(|text| {
                    Frame::decode(text, self.max_frame_bytes)
                        .map_err(|issue| error(format!("runner connection failed: {issue}")))
                })
                .collect::<Result<Vec<_>, _>>()?;
            if frames
                .iter()
                .any(|frame| matches!(frame, Frame::Reply { .. }))
            {
                ANSWERED.with_borrow_mut(|scopes| scopes.insert(self.scope.clone()));
            }
            Ok(frames)
        })
    }

    fn close<'a>(&'a self, reason: &'a str) -> HostFuture<'a, ()> {
        Box::pin(async move {
            let _ = call(
                json!({"op": "remote_close", "connection": self.connection, "reason": reason}),
            )
            .await;
        })
    }

    fn changed(&self) {
        spawn(async {
            let _ = call(json!({"op": "wake"})).await;
        });
    }

    fn max_frame_bytes(&self) -> Option<usize> {
        Some(self.max_frame_bytes)
    }
}

struct Recovering {
    client: RemoteClient,
    connection: Option<String>,
    max_frame_bytes: usize,
}

impl RemoteTransport for Recovering {
    fn supports_tool_selection(&self) -> bool {
        self.client.supports_tool_selection()
    }

    fn request<'a>(
        &'a self,
        operation: RemoteOperation,
        local_tools: Vec<Arc<dyn Tool>>,
        observer: Option<&'a mut dyn CodeModeObserver>,
    ) -> HostFuture<'a, Result<Option<CodeModeExecution>, CodeModeHostError>> {
        self.client.request(operation, local_tools, observer)
    }

    fn call(&self, operation: RemoteOperation) -> HostFuture<'_, Result<Value, CodeModeHostError>> {
        self.client.call(operation)
    }

    fn recover<'a>(
        &'a self,
        context: &'a RemoteContext,
    ) -> Option<HostFuture<'a, Result<Option<Value>, CodeModeHostError>>> {
        Some(Box::pin(async move {
            let found = call(json!({"op": "remote_recover", "connection": self.connection, "session_id": context.session_id, "call_id": context.call_id}))
                .await
                .map_err(host_error)?;
            let Some(text) = found.get("frame").and_then(Value::as_str) else {
                return Ok(None);
            };
            match Frame::decode(text, self.max_frame_bytes)? {
                Frame::Reply {
                    result: Ok(value), ..
                } => Ok(value),
                Frame::Reply {
                    result: Err(message),
                    ..
                } if message == NOT_RECEIVED || message == REQUEST_IN_USE => {
                    Err(CodeModeHostError::unsent(message))
                }
                Frame::Reply {
                    result: Err(message),
                    ..
                } => Err(error(message)),
                _ => Err(error("the recovered hand frame is not a reply")),
            }
        }))
    }

    fn route_hands(&self, hands: Arc<dyn HandCalls>) {
        self.client.route_hands(hands);
    }

    fn notify(&self, operation: RemoteOperation) -> Result<(), CodeModeHostError> {
        self.client.notify(operation)
    }

    fn detach_turn(
        &self,
        session_id: &str,
        observer: &mut (dyn FnMut(&str) -> Box<dyn CodeModeObserver> + Send),
    ) -> Result<(), CodeModeHostError> {
        self.client.detach_turn(session_id, observer)
    }
}

pub fn catalog(frame: &str, max_frame_bytes: usize) -> Result<Value, String> {
    let catalog = RemoteCatalog::decode(frame, max_frame_bytes).map_err(|e| e.to_string())?;
    Ok(json!({"name": catalog.name, "runtime_id": catalog.runtime_id}))
}

pub async fn host(connection: Option<String>, scope: &str) -> Result<RemoteCodeModeHost, String> {
    let catalog = call(json!({"op": "remote_catalog", "connection": connection}))
        .await
        .map_err(|issue| host_error(issue).to_string())?;
    let max_frame_bytes: usize =
        serde_json::from_value(catalog["max_frame_bytes"].clone()).map_err(|e| e.to_string())?;
    let timeout_ms: u64 =
        serde_json::from_value(catalog["timeout_ms"].clone()).map_err(|e| e.to_string())?;
    if max_frame_bytes == 0 || timeout_ms == 0 {
        return Err("max_frame_bytes and timeout_ms must be positive".into());
    }
    let resumes = catalog["resumes"].as_bool() == Some(true);
    let text = catalog["frame"]
        .as_str()
        .ok_or("remote catalog frame must be text")?;
    let catalog = RemoteCatalog::decode(text, max_frame_bytes).map_err(|e| e.to_string())?;
    let max_frame_bytes = catalog
        .max_frame_bytes
        .map_or(max_frame_bytes, |peer| peer.min(max_frame_bytes));
    let (client, driver) = RemoteClient::new(
        WorkerLink {
            connection: connection.clone(),
            tool_selection: catalog.tool_selection,
            caches_local_tools: catalog.caches_local_tools,
            resumes: catalog.resumes().filter(|_| resumes).map(str::to_owned),
            max_frame_bytes,
            scope: scope.to_owned(),
        },
        Some(Duration::from_millis(timeout_ms)),
    );
    ACTIVITY.with_borrow_mut(|activity| {
        activity.retain(RemoteActivity::is_alive);
        activity.push(client.activity());
    });
    spawn(async move {
        driver.await;
    });
    Ok(RemoteCodeModeHost::new(
        Recovering {
            client,
            connection,
            max_frame_bytes,
        },
        catalog.definitions.clone(),
    )
    .described(&catalog))
}
