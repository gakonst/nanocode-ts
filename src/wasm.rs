mod bridge;
mod events;
mod remote;
mod store;
mod tools;
mod transport;

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    future::Future,
    pin::Pin,
    rc::Rc,
    sync::Arc,
    time::Duration,
};

use nanocode::{
    ClaudeClient, ClaudeModel, CodeModeExecutors, CodeModeHost, Model, ModelSelection,
    ModelTransport, Nanocode, OpenAi, PromptRejection, ServiceTier, Thinking, Tools,
    backend::Prompt,
    codex::{
        OpenAiAuth,
        transport::{ResponsesGateway, ResponsesTransport},
    },
    durability::{InitialSettings, SessionRecord, SqlStore},
    session_host::{
        Driven, ImportedTurn, SessionLog, Submission, Submitted, TurnInbox, TurnRecord, TurnState,
    },
};
use nanocode_code_mode::remote::PLACEMENT_INSTRUCTIONS;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json, value::RawValue};

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Provider {
    #[default]
    Claude,
    Codex,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Gateway {
    Vercel,
}

impl Provider {
    fn model(self) -> ModelSelection {
        match self {
            Self::Claude => ModelSelection::Claude(ClaudeModel::Opus55),
            Self::Codex => ModelSelection::Codex(Model::Sol),
        }
    }
}

#[derive(Deserialize)]
struct Configuration {
    scope: String,
    session_id: String,
    runtime_id: String,
    started_ms: f64,
    #[serde(default)]
    provider: Provider,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    thinking: Option<String>,
    #[serde(default)]
    instructions: Option<String>,
    subscription: bool,
    endpoint: String,
    #[serde(default)]
    gateway: Option<Gateway>,
    #[serde(default)]
    remote: bool,
    #[serde(default)]
    executor: Option<String>,
    #[serde(default)]
    hands: bool,
    #[serde(default)]
    event_coalesce_ms: u64,
    #[serde(default)]
    tools: Vec<tools::HostTool>,
}

impl Configuration {
    fn model(&self) -> Result<ModelSelection, String> {
        let Some(model) = &self.model else {
            return Ok(self.provider.model());
        };
        model
            .parse::<ModelSelection>()
            .map_err(|error| format!("model {model}: {error}"))
    }

    fn thinking(&self) -> Result<Option<Thinking>, String> {
        self.thinking.as_deref().map(str::parse).transpose()
    }
}

#[derive(Deserialize)]
struct Legacy {
    request_id: String,
    status: String,
    prompt: String,
    #[serde(default)]
    hand: Option<String>,
    metadata: Value,
    #[serde(default)]
    cancel_requested: bool,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    first_seq: Option<u64>,
    #[serde(default)]
    last_seq: Option<u64>,
    #[serde(default)]
    result: Option<Map<String, Value>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Command {
    Configure {
        #[serde(default)]
        value_limit: Option<usize>,
    },
    Init {
        config: Configuration,
    },
    Submit {
        scope: String,
        request_id: String,
        prompt: String,
        #[serde(default)]
        hand: Option<String>,
        metadata: Value,
    },
    Turn {
        scope: String,
        request_id: String,
    },
    Pending {
        scope: String,
    },
    Cancel {
        scope: String,
        request_id: String,
        #[serde(default)]
        fields: Map<String, Value>,
    },
    Interrupted {
        scope: String,
        request_id: String,
        note: String,
    },
    Retry {
        scope: String,
        request_id: String,
        error: String,
        kind: String,
        retry_at: u64,
    },
    Finish {
        scope: String,
        request_id: String,
        status: String,
        #[serde(default)]
        fields: Map<String, Value>,
    },
    Page {
        scope: String,
        after: u64,
        limit: usize,
        #[serde(default)]
        request_id: Option<String>,
    },
    Import {
        scope: String,
        turns: Vec<Legacy>,
    },
    Drive {
        #[serde(default)]
        next: Option<String>,
    },
    Attach {
        hand: String,
        connection: String,
    },
    Detach {
        connection: String,
    },
    Settle {},
    Preconnect {},
    Thinking {
        thinking: String,
        apply: bool,
    },
    Steer {
        request_id: String,
        prompt: String,
    },
    Dispose {},
    Catalog {
        frame: String,
        max_frame_bytes: usize,
    },
    Admit {
        request_id: String,
        recorded: Option<Provider>,
        requested: Provider,
    },
}

type Log = SessionLog<store::WorkerStore>;

type Hand = (String, Arc<dyn CodeModeHost>);

struct Session {
    executors: CodeModeExecutors,
    hands: RefCell<HashMap<String, Hand>>,
    inbox: TurnInbox<store::WorkerStore>,
    scope: String,
}

enum Phase {
    Empty,
    Starting,
    Ready(Rc<Session>),
    Closing,
    Closed,
}

thread_local! {
    static PHASE: RefCell<Phase> = const { RefCell::new(Phase::Empty) };
    static LOGS: RefCell<HashMap<String, Arc<Log>>> = RefCell::new(HashMap::new());
    static VALUE_LIMIT: Cell<Option<usize>> = const { Cell::new(None) };
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

enum Opening {
    Configuration(String),
    Failed(String),
}

impl From<String> for Opening {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}

fn configuration(error: impl std::fmt::Display) -> Opening {
    Opening::Configuration(error.to_string())
}

fn log(scope: &str) -> Arc<Log> {
    LOGS.with_borrow_mut(|logs| {
        Arc::clone(logs.entry(scope.to_owned()).or_insert_with(|| {
            let log = SessionLog::new(Arc::new(store::WorkerStore::log()), scope);
            Arc::new(match VALUE_LIMIT.get() {
                Some(limit) => log.value_limit(limit),
                None => log,
            })
        }))
    })
}

fn current() -> Option<Rc<Session>> {
    PHASE.with_borrow(|phase| match phase {
        Phase::Ready(session) => Some(Rc::clone(session)),
        _ => None,
    })
}

fn ready() -> Result<Rc<Session>, String> {
    current().ok_or_else(|| "agent runtime is not ready".into())
}

fn described(record: &TurnRecord) -> Result<Value, String> {
    Ok(json!({
        "report": record.report().map_err(text)?,
        "first_seq": record.first_seq,
        "last_seq": record.last_seq,
        "cancel_requested": record.cancel_requested,
        "metadata": record.metadata,
    }))
}

async fn open(config: Configuration) -> Result<Session, Opening> {
    let coalesce = Duration::from_millis(config.event_coalesce_ms);
    let store =
        nanocode::session_store(SqlStore::new(store::WorkerStore::durability())).map_err(text)?;
    let model = config.model().map_err(configuration)?;
    let thinking = config.thinking().map_err(configuration)?;
    let mut builder = Nanocode::builder();
    builder = match config.provider {
        Provider::Claude => {
            if model.as_claude().is_none() {
                return Err(configuration(format!("{model} is not a Claude model")));
            }
            let http = nanocode::claude::transport::HttpClient::new(
                nanocode::claude::transport::SenderTransport(transport::WorkerTransport),
            );
            let mut client =
                ClaudeClient::with_auth_headers(http, config.endpoint, http::HeaderMap::new());
            if config.subscription {
                client = client.subscription_compatibility();
            }
            builder.claude(client)
        }
        Provider::Codex => {
            let Some(codex) = model.as_codex() else {
                return Err(configuration(format!("{model} is not a Codex model")));
            };
            let openai = match (config.subscription, config.gateway) {
                (true, Some(Gateway::Vercel)) => {
                    return Err(configuration(
                        "the Vercel AI Gateway serves Codex API-key sessions, not ChatGPT subscriptions",
                    ));
                }
                (true, None) => OpenAi::builder(OpenAiAuth::host_managed_chatgpt())
                    .transport(ResponsesTransport::WebSocket)
                    .websocket_warmup(false),
                (false, Some(Gateway::Vercel)) => OpenAi::builder(OpenAiAuth::gateway_managed())
                    .responses_gateway(ResponsesGateway::vercel()),
                (false, None) => OpenAi::builder(OpenAiAuth::gateway_managed())
                    .transport(ResponsesTransport::Https),
            };
            builder.openai(
                openai
                    .model(codex)
                    .raw_api_events(false)
                    .api_base_url(config.endpoint)
                    .host_transport(transport::WorkerTransport)
                    .build()
                    .map_err(configuration)?,
            )
        }
    };
    let executors = CodeModeExecutors::new();
    let selected = tools::tools(config.tools)
        .fold(
            Tools::builder().without_defaults().tool(executors.tool()),
            |selected, tool| selected.tool(tool),
        )
        .build()
        .map_err(configuration)?;
    builder = builder
        .workspace("/")
        .tools(selected)
        .durability(store.clone());
    if config.remote {
        let name: Arc<str> = config.executor.as_deref().unwrap_or("default").into();
        executors.insert(Arc::clone(&name), Arc::new(remote::host(None).await?));
        executors.set_default(Some(name));
    }
    let placement = config.remote || config.hands;
    let instructions = [
        config.instructions.as_deref(),
        placement.then_some(PLACEMENT_INSTRUCTIONS),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    if !instructions.is_empty() {
        builder = builder.instructions(instructions);
    }
    if placement {
        builder = builder
            .code_mode_host(executors.clone())
            .map_err(configuration)?;
    }
    let runtime = builder
        .build()
        .map_err(|error| configuration(format!("build runtime: {error}")))?;
    let host = Arc::new(events::WorkerInbox::new(
        config.runtime_id,
        config.started_ms,
        executors.clone(),
    ));
    let mut record = SessionRecord::root(&config.session_id, model, None);
    record.initial = thinking.map(|thinking| InitialSettings {
        thinking,
        service_tier: ServiceTier::Standard,
    });
    match TurnInbox::open(
        (*runtime).clone(),
        &store,
        record,
        log(&config.scope),
        host,
        coalesce,
    )
    .await
    {
        Ok((inbox, pump)) => {
            bridge::spawn(pump);
            Ok(Session {
                executors,
                hands: RefCell::default(),
                inbox,
                scope: config.scope,
            })
        }
        Err(error) => {
            let _ = runtime.shutdown().await;
            Err(Opening::Failed(error.to_string()))
        }
    }
}

async fn init(config: Configuration) -> Result<Value, String> {
    let admitted = PHASE.with_borrow_mut(|phase| {
        matches!(phase, Phase::Empty) && {
            *phase = Phase::Starting;
            true
        }
    });
    if !admitted {
        return Err("agent runtime is already initialized".into());
    }
    match open(config).await {
        Ok(session) => {
            let summary = json!({
                "session_id": session.inbox.session_id(),
                "model": session.inbox.model(),
            });
            let session = Rc::new(session);
            PHASE.set(Phase::Ready(Rc::clone(&session)));
            bridge::spawn(async move { session.inbox.deliver_completions().await });
            Ok(summary)
        }
        Err(Opening::Configuration(error)) => {
            PHASE.set(Phase::Closed);
            Ok(json!({"rejected": {"error": error, "kind": "configuration"}}))
        }
        Err(Opening::Failed(error)) => {
            PHASE.set(Phase::Closed);
            Err(error)
        }
    }
}

impl Session {
    async fn attach(&self, hand: String, connection: String) -> Result<Value, String> {
        let host: Arc<dyn CodeModeHost> = Arc::new(remote::host(Some(connection.clone())).await?);
        self.executors.insert(hand.as_str(), Arc::clone(&host));
        self.hands.borrow_mut().insert(connection, (hand, host));
        Ok(Value::Null)
    }

    fn detach(&self, connection: &str) -> Value {
        if let Some((hand, host)) = self.hands.borrow_mut().remove(connection) {
            self.executors.remove_host(&hand, &host);
        }
        Value::Null
    }

    async fn drive(&self, next: Option<&str>) -> Result<Value, String> {
        Ok(match self.inbox.drive(next).await.map_err(text)? {
            Driven::Idle => json!({"idle": true}),
            Driven::Busy => json!({"waiting": true, "busy": true}),
            Driven::Finished(record) => json!({"finished": described(&record)?}),
            Driven::Resumed(request_id) => json!({"resumed": request_id}),
            Driven::Waiting(request_id) => json!({"waiting": true, "request_id": request_id}),
            Driven::Interrupted(request_id) => json!({"retry": true, "request_id": request_id}),
        })
    }
}

async fn submit(
    scope: &str,
    request_id: String,
    prompt: String,
    hand: Option<String>,
    metadata: &Value,
) -> Result<Value, String> {
    let submission = Submission {
        request_id,
        prompt: Prompt::from(prompt),
        hand,
        metadata: serde_json::value::to_raw_value(metadata).map_err(text)?,
    };
    let (status, record) = match log(scope).submit(&submission).await.map_err(text)? {
        Submitted::Accepted { record, event } => {
            events::publish(vec![event]).await?;
            ("accepted", record)
        }
        Submitted::Existing(record) => ("existing", record),
        Submitted::Conflict(record) => ("conflict", record),
        Submitted::TooLarge { bytes, limit } => {
            return Ok(json!({"submitted": "too_large", "bytes": bytes, "limit": limit}));
        }
    };
    Ok(json!({"submitted": status, "turn": described(&record)?}))
}

async fn cancel(
    scope: &str,
    request_id: &str,
    fields: &Map<String, Value>,
) -> Result<Value, String> {
    let cancelled = match current() {
        Some(session) if session.scope == scope => session
            .inbox
            .cancel(request_id, fields)
            .await
            .map_err(text)?,
        _ => match log(scope).cancel(request_id, fields).await.map_err(text)? {
            Some((record, event)) => {
                let dequeued = event.is_some();
                if let Some(event) = event {
                    events::publish(vec![event]).await?;
                }
                Some((record, dequeued))
            }
            None => None,
        },
    };
    Ok(match cancelled {
        Some((record, dequeued)) => json!({"turn": described(&record)?, "dequeued": dequeued}),
        None => json!({"turn": null}),
    })
}

async fn retry(
    scope: &str,
    request_id: &str,
    error: &str,
    kind: &str,
    retry_at: u64,
) -> Result<Value, String> {
    let retried = log(scope)
        .retry(request_id, error, kind, retry_at)
        .await
        .map_err(text)?;
    let Some((record, event)) = retried else {
        return Ok(json!({"turn": null}));
    };
    if let Some(event) = event {
        events::publish(vec![event]).await?;
    }
    Ok(json!({"turn": described(&record)?}))
}

async fn finish(
    scope: &str,
    request_id: &str,
    status: &str,
    fields: &Map<String, Value>,
) -> Result<Value, String> {
    let state = TurnState::parse(status).map_err(text)?;
    if let Some((_, event)) = log(scope)
        .finish(request_id, state, fields)
        .await
        .map_err(text)?
    {
        events::publish(vec![event]).await?;
    }
    Ok(Value::Null)
}

async fn import(scope: &str, turns: Vec<Legacy>) -> Result<Value, String> {
    let turns = turns
        .into_iter()
        .map(|turn| {
            Ok(ImportedTurn {
                request_id: turn.request_id,
                state: TurnState::parse(&turn.status).map_err(text)?,
                prompt: Prompt::from(turn.prompt),
                hand: turn.hand,
                metadata: serde_json::value::to_raw_value(&turn.metadata).map_err(text)?,
                cancel_requested: turn.cancel_requested,
                note: turn.note,
                first_seq: turn.first_seq,
                last_seq: turn.last_seq,
                result: turn.result,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    log(scope)
        .import(&turns)
        .await
        .map(Value::from)
        .map_err(text)
}

async fn dispose() -> Result<Value, String> {
    let previous = PHASE.with_borrow_mut(|phase| match phase {
        Phase::Starting | Phase::Closing => None,
        _ => Some(std::mem::replace(phase, Phase::Closing)),
    });
    let Some(previous) = previous else {
        return Err("agent runtime is changing state".into());
    };
    let Phase::Ready(session) = previous else {
        PHASE.set(Phase::Closed);
        return Ok(Value::Null);
    };
    let shutdown = session.inbox.shutdown().await.map_err(text);
    drop(session);
    PHASE.set(Phase::Closed);
    shutdown.map(|()| Value::Null)
}

fn raw(value: &impl Serialize) -> Result<Box<RawValue>, String> {
    serde_json::value::to_raw_value(value).map_err(text)
}

type Executed = Pin<Box<dyn Future<Output = Result<Box<RawValue>, String>>>>;

fn executed<T: Serialize>(future: impl Future<Output = Result<T, String>> + 'static) -> Executed {
    Box::pin(async move { raw(&future.await?) })
}

fn execute(command: Command) -> Executed {
    match command {
        Command::Configure { value_limit } => executed(async move {
            VALUE_LIMIT.set(value_limit);
            Ok(Value::Null)
        }),
        Command::Init { config } => executed(init(config)),
        Command::Submit {
            scope,
            request_id,
            prompt,
            hand,
            metadata,
        } => executed(async move { submit(&scope, request_id, prompt, hand, &metadata).await }),
        Command::Turn { scope, request_id } => executed(async move {
            let record = log(&scope).turn(&request_id).await.map_err(text)?;
            Ok(json!({"turn": record.as_ref().map(described).transpose()?}))
        }),
        Command::Pending { scope } => executed(async move {
            let records = log(&scope).pending().await.map_err(text)?;
            Ok(json!({"turns": records.iter().map(described).collect::<Result<Vec<_>, _>>()?}))
        }),
        Command::Cancel {
            scope,
            request_id,
            fields,
        } => executed(async move { cancel(&scope, &request_id, &fields).await }),
        Command::Interrupted {
            scope,
            request_id,
            note,
        } => executed(async move {
            log(&scope)
                .interrupted(&request_id, &note)
                .await
                .map_err(text)?;
            Ok(Value::Null)
        }),
        Command::Retry {
            scope,
            request_id,
            error,
            kind,
            retry_at,
        } => executed(async move { retry(&scope, &request_id, &error, &kind, retry_at).await }),
        Command::Finish {
            scope,
            request_id,
            status,
            fields,
        } => executed(async move { finish(&scope, &request_id, &status, &fields).await }),
        Command::Page {
            scope,
            after,
            limit,
            request_id,
        } => executed(async move {
            let log = log(&scope);
            match request_id {
                Some(request_id) => log.turn_page(&request_id, after, limit).await,
                None => log.page(after, limit).await,
            }
            .map_err(text)
        }),
        Command::Import { scope, turns } => executed(async move { import(&scope, turns).await }),
        Command::Drive { next } => executed(async move { ready()?.drive(next.as_deref()).await }),
        Command::Attach { hand, connection } => {
            executed(async move { ready()?.attach(hand, connection).await })
        }
        Command::Detach { connection } => executed(async move {
            Ok(match current() {
                Some(session) => session.detach(&connection),
                None => Value::Null,
            })
        }),
        Command::Settle {} => executed(async move { ready()?.inbox.settle().await.map_err(text) }),
        Command::Preconnect {} => executed(async move {
            ready()?.inbox.agent().preconnect().await.map_err(text)?;
            Ok(Value::Null)
        }),
        Command::Thinking { thinking, apply } => executed(async move {
            let thinking = thinking.parse::<Thinking>().map_err(text)?;
            let session = ready()?;
            session
                .inbox
                .model()
                .parse::<ModelSelection>()
                .map_err(text)?
                .capabilities(ModelTransport::Native)
                .check_thinking(thinking)
                .map_err(text)?;
            if apply {
                session
                    .inbox
                    .agent()
                    .set_thinking(thinking)
                    .await
                    .map_err(text)?;
            }
            Ok(Value::Null)
        }),
        Command::Steer { request_id, prompt } => executed(async move {
            let steered = ready()?
                .inbox
                .steer(&request_id, Prompt::from(prompt))
                .await
                .map_err(text)?;
            Ok(Value::Bool(steered))
        }),
        Command::Dispose {} => executed(dispose()),
        Command::Catalog {
            frame,
            max_frame_bytes,
        } => executed(async move { remote::catalog(&frame, max_frame_bytes) }),
        Command::Admit {
            request_id,
            recorded,
            requested,
        } => executed(async move {
            Ok(
                match nanocode::admit_prompt(
                    recorded.map(|provider| provider.model().family()).as_ref(),
                    &requested.model().family(),
                    &request_id,
                ) {
                    Ok(()) => Value::Null,
                    Err(PromptRejection::ReservedRequestId(_)) => {
                        json!({"rejected": "reserved_request_id"})
                    }
                    Err(PromptRejection::HarnessChanged { .. }) => {
                        json!({"rejected": "provider_changed"})
                    }
                },
            )
        }),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Reply {
    Ok(Box<RawValue>),
    Error(String),
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn command(id: u32, pointer: *mut u8, length: usize) {
    let bytes = unsafe { bridge::take_bytes(pointer, length) };
    bridge::install();
    bridge::spawn(async move {
        let result = match serde_json::from_slice::<Command>(&bytes) {
            Ok(command) => execute(command).await,
            Err(error) => Err(error.to_string()),
        };
        bridge::respond(
            id,
            &match result {
                Ok(value) => Reply::Ok(value),
                Err(error) => Reply::Error(error),
            },
        );
    });
}
