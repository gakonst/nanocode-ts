use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    sync::Arc,
};

use futures_channel::oneshot;
use nanocode::{Tool, tool_contract::ToolContext};
use nanocode_code_mode::{
    ToolDefinition, ToolInput, ToolResult,
    code_mode::{CodeModeExecution, CodeModeObserver, CodeModeUpdate, LocalCells},
    embedded::CodeModeHost,
    remote::{
        NOT_RECEIVED, RemoteContext, RemoteFrame as Frame, RemoteOperation, SentCalls,
        output_from_wire,
    },
};
use serde_json::{Value, json};

use super::{
    bridge::{call, spawn},
    cells, mcp, tools,
};

const DEFAULT_MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

thread_local! {
    static CELLS: RefCell<Option<Arc<LocalCells>>> = const { RefCell::new(None) };
    static OWN: RefCell<Vec<Arc<dyn Tool>>> = const { RefCell::new(Vec::new()) };
    static LIMIT: Cell<usize> = const { Cell::new(DEFAULT_MAX_FRAME_BYTES) };
    static NEXT: Cell<u64> = const { Cell::new(0) };
    static PENDING: RefCell<HashMap<u64, oneshot::Sender<Result<Value, String>>>> = RefCell::new(HashMap::new());
}

fn send(frame: &Frame) -> Result<(), String> {
    let text = frame
        .encode(LIMIT.get())
        .map_err(|error| error.to_string())?;
    spawn(async move {
        let _ = call(json!({"op": "hand_send", "text": text})).await;
    });
    Ok(())
}

fn cells() -> Result<Arc<LocalCells>, String> {
    CELLS.with_borrow(|cells| cells.clone().ok_or_else(|| "the hand is not open".to_owned()))
}

pub async fn open(
    name: Option<String>,
    workspace: Option<String>,
    max_frame_bytes: Option<usize>,
    host_tools: Vec<tools::HostTool>,
    mcp_servers: Vec<mcp::Server>,
) -> Result<Value, String> {
    let limit = max_frame_bytes.unwrap_or(DEFAULT_MAX_FRAME_BYTES);
    LIMIT.set(limit);
    let mut own: Vec<Arc<dyn Tool>> = tools::tools(host_tools)
        .map(|tool| Arc::new(tool) as Arc<dyn Tool>)
        .collect();
    own.extend(
        mcp::tools(mcp_servers)
            .await
            .map_err(|failure| match failure {
                mcp::Failure::Configuration(error) | mcp::Failure::Unavailable(error) => error,
            })?
            .into_iter()
            .map(|tool| Arc::new(tool) as Arc<dyn Tool>),
    );
    let definitions = own.iter().map(|tool| tool.definition()).collect();
    OWN.set(own);
    CELLS.set(Some(Arc::new(cells::host(workspace.as_deref()))));
    let catalog = Frame::Catalog {
        definitions,
        name,
        workspace,
        runtime_id: None,
        max_frame_bytes: Some(limit),
        resumable: false,
        tool_selection: true,
        cancels_calls: false,
    };
    catalog
        .encode(limit)
        .map(Value::String)
        .map_err(|error| error.to_string())
}

pub fn closed() {
    for (_, reply) in PENDING.with_borrow_mut(std::mem::take) {
        let _ = reply.send(Err("the hand's connection to the session closed".into()));
    }
}

pub fn receive(text: &str) -> Result<Value, String> {
    let frame = Frame::decode(text, LIMIT.get()).map_err(|error| error.to_string())?;
    match frame {
        Frame::CallbackResult { id, result } => {
            if let Some(reply) = PENDING.with_borrow_mut(|pending| pending.remove(&id)) {
                let _ = reply.send(result);
            }
        }
        Frame::Ack { .. } => {}
        Frame::Resume { pending } => {
            for id in pending {
                send(&Frame::Reply { id, result: Err(NOT_RECEIVED.into()) })?;
            }
        }
        Frame::Request { id, operation, max_frame_bytes, compact, .. } => {
            if let Some(bytes) = max_frame_bytes {
                LIMIT.set(LIMIT.get().min(bytes));
            }
            let cells = cells()?;
            spawn(async move {
                let result = run(&cells, id, operation, compact).await;
                let _ = send(&reply(id, result));
            });
        }
        _ => return Err("unexpected frame from the session".into()),
    }
    Ok(Value::Null)
}

fn reply(id: u64, result: Result<Option<Value>, String>) -> Frame {
    let frame = Frame::Reply { id, result };
    match frame.encode(LIMIT.get()) {
        Ok(_) => frame,
        Err(issue) => Frame::Reply { id, result: Err(format!("{issue}; the result was not sent")) },
    }
}

struct Observer {
    id: u64,
    calls: SentCalls,
}

impl CodeModeObserver for Observer {
    fn update(&mut self, update: CodeModeUpdate<'_>) {
        if send(&Frame::Update { id: self.id, update: self.calls.update(&update) }).is_ok() {
            self.calls.sent(&update);
        }
    }
}

struct Detached {
    session_id: String,
    origin_call_id: String,
    calls: SentCalls,
}

impl CodeModeObserver for Detached {
    fn update(&mut self, update: CodeModeUpdate<'_>) {
        let _ = send(&Frame::DetachedUpdate {
            session_id: self.session_id.clone(),
            origin_call_id: self.origin_call_id.clone(),
            update: self.calls.update(&update),
        });
    }

    fn completed(&mut self) {
        let _ = send(&Frame::DetachedComplete {
            session_id: self.session_id.clone(),
            origin_call_id: self.origin_call_id.clone(),
        });
    }
}

struct Callback {
    definition: ToolDefinition,
}

impl Tool for Callback {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn execute<'life0, 'life1, 'async_trait>(
        &'life0 self,
        input: ToolInput,
        context: ToolContext<'life1>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ToolResult> + 'async_trait>>
    where
        'life0: 'async_trait,
        'life1: 'async_trait,
        Self: 'async_trait,
    {
        let context = RemoteContext::from_context(context);
        let name = self.definition.name().to_owned();
        Box::pin(async move {
            let (input, freeform) = match input {
                ToolInput::Function(input) => (serde_json::from_str(input.get())?, false),
                ToolInput::Freeform(input) => (Value::String(input), true),
            };
            let id = NEXT.get();
            NEXT.set(id + 1);
            let (tx, rx) = oneshot::channel();
            PENDING.with_borrow_mut(|pending| pending.insert(id, tx));
            if let Err(issue) = send(&Frame::Callback { id, name, input, freeform, context, hand: None, compact: true }) {
                PENDING.with_borrow_mut(|pending| pending.remove(&id));
                return Err(format!("{issue}; the call was not dispatched").into());
            }
            let value = rx
                .await
                .map_err(|_| "the hand's connection to the session closed; outcome unknown".to_owned())??;
            output_from_wire(value).map_err(|error| error.to_string().into())
        })
    }
}

fn wire(execution: CodeModeExecution, observer: Observer) -> Value {
    observer.calls.execution(execution)
}

async fn run(cells: &LocalCells, id: u64, operation: RemoteOperation, compact: bool) -> Result<Option<Value>, String> {
    let mut observer = Observer { id, calls: SentCalls::new(compact) };
    match operation {
        RemoteOperation::Execute { source, context, local_tools, .. } => {
            let mut tools: Vec<Arc<dyn Tool>> = OWN.with_borrow(Clone::clone);
            tools.extend(
                local_tools
                    .into_iter()
                    .filter(|definition| !tools.iter().any(|own| own.definition().name() == definition.name()))
                    .map(|definition| Arc::new(Callback { definition }) as Arc<dyn Tool>)
                    .collect::<Vec<_>>(),
            );
            let owned = context.owned();
            let execution = cells
                .execute_with_local_tools(&source, owned.as_context(), tools, Some(&mut observer))
                .await
                .map_err(|error| error.to_string())?;
            Ok(Some(wire(execution, observer)))
        }
        RemoteOperation::Wait { input, context } => {
            let owned = context.owned();
            let execution = cells
                .wait_with_updates(&input, owned.as_context(), &mut observer)
                .await
                .map_err(|error| error.to_string())?;
            Ok(Some(wire(execution, observer)))
        }
        RemoteOperation::Call { name, input, context, .. } => {
            let tool = OWN.with_borrow(|own| own.iter().find(|tool| tool.definition().name() == name).cloned());
            let Some(tool) = tool else {
                return Err(format!("this browser hand has no tool `{name}`"));
            };
            let owned = context.owned();
            let raw = serde_json::value::to_raw_value(&input).map_err(|error| error.to_string())?;
            let output = tool
                .execute(ToolInput::Function(raw), owned.as_context())
                .await
                .unwrap_or_else(|error| nanocode_code_mode::ToolOutput::error(error.to_string()));
            nanocode_code_mode::remote::output_to_wire(output, compact)
                .map(Some)
                .map_err(|error| error.to_string())
        }
        RemoteOperation::Cancel { session_id } => {
            cells.cancel_with_updates(&session_id, &mut observer).await.map_err(|error| error.to_string())?;
            Ok(None)
        }
        RemoteOperation::CancelTurn { session_id, .. } => {
            cells.cancel_turn_with_updates(&session_id, &mut observer).await.map_err(|error| error.to_string())?;
            Ok(None)
        }
        RemoteOperation::DetachTurn { session_id } => {
            let id = session_id.clone();
            cells.detach_turn(&session_id, &mut |origin| {
                Box::new(Detached { session_id: id.clone(), origin_call_id: origin.into(), calls: SentCalls::new(compact) })
            });
            Ok(None)
        }
        RemoteOperation::BeginTurn { session_id } => {
            cells.begin_turn(&session_id);
            Ok(None)
        }
        RemoteOperation::Preempt { session_id } => {
            cells.preempt_turn(&session_id).await.map_err(|error| error.to_string())?;
            Ok(None)
        }
        RemoteOperation::SettlePreempt { session_id } => {
            cells.settle_preempt(&session_id);
            Ok(None)
        }
        RemoteOperation::CancelCall { .. } | RemoteOperation::EndTurn { .. } => Ok(None),
    }
}

