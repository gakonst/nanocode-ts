mod branch;
mod bridge;
mod cells;
mod events;
mod hand;
mod mcp;
mod remote;
mod store;
mod tools;
mod transport;
mod workspace;

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
    AgentId, ClaudeClient, ClaudeHarness, ClaudeModel, CodeModeExecutors, CodeModeHost,
    CodexHarness, HarnessFamily, Model, ModelSelection, ModelTransport, Nanocode, NanocodeError,
    OpenAi, PromptRejection, ReasoningMode, ServiceTier, SubagentControl, Thinking, Tools,
    agent::{ExecutionEnvironment, input::UserInput},
    backend::Prompt,
    claude::ClaudeEnvironment,
    codex::{
        CONTEXT_WINDOW_TOKENS, OpenAiAuth, auto_compact_token_limit,
        transport::{ChatGateway, ResponsesGateway, ResponsesTransport},
    },
    durability::{
        BranchCursor, BranchExport, BranchPage, InitialSettings, SessionRecord, SqlStore,
    },
    session_host::{
        Driven, ImportedTurn, InboxError, LogEntry, LoggedEvent, MovedQueued, Replaced, SessionLog,
        Submission, Submitted, TurnInbox, TurnRecord, TurnState,
    },
    tool_contract::{Tool, ToolCollection},
};
use nanocode_code_mode::remote::PLACEMENT_INSTRUCTIONS;
use serde::{Deserialize, Serialize};

const LOCAL_INSTRUCTIONS: &str = "Code Mode scripts run in QuickJS inside this host, not on a separate machine; Node, Deno and browser APIs other than the ones listed here do not exist in them. The global `fetch` makes HTTP requests from the host, which may pay for them, and returns a Response-like object (`ok`, `status`, `headers.get`, `text()`, `json()`, `arrayBuffer()`). When the session has a workspace, the globals `bash` and `wasm` reach it: `await bash(script)` runs the simulated shell, `await wasm.run(bytesOrPath, args, { stdin })` runs a WASI program and resolves to `{ stdout, stderr, exitCode }`, and `await wasm.invoke(bytesOrPath, name, ...numbers)` calls one export. `WebAssembly.instantiate(bytes)` and `new WebAssembly.Instance(module)` also work, but every export is an async function (`await instance.exports.add(20, 22)`), i64 values are BigInts, a memory export has async `read(offset, length)` and `write(offset, bytes)`, and imports are not supported. These are globals, not `tools.*` entries.";
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
    WorkersAi,
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
#[serde(deny_unknown_fields)]
struct Endpoint {
    endpoint: String,
    #[serde(default)]
    subscription: bool,
    #[serde(default)]
    gateway: Option<Gateway>,
    #[serde(default)]
    cloudflare_account_id: Option<String>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    instructions: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Providers {
    #[serde(default)]
    claude: Option<Endpoint>,
    #[serde(default)]
    codex: Option<Endpoint>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
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
    cloudflare_account_id: Option<String>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    service_tier: Option<ServiceTier>,
    #[serde(default)]
    subagents: Option<bool>,
    #[serde(default)]
    providers: Providers,
    #[serde(default)]
    remote: bool,
    #[serde(default)]
    executor: Option<String>,
    #[serde(default)]
    hands: bool,
    #[serde(default)]
    code_mode: bool,
    #[serde(default)]
    event_coalesce_ms: u64,
    #[serde(default)]
    stream_tool_input: bool,
    #[serde(default)]
    auto_compact_window_tokens: Option<u64>,
    #[serde(default)]
    environment: Option<Environment>,
    #[serde(default)]
    tools: Vec<tools::HostTool>,
    #[serde(default)]
    web_search: WebSearch,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    mcp_servers: Vec<mcp::Server>,
    #[serde(default)]
    hand_tools: Option<HashMap<String, remote::ToolSelection>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Environment {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    shell: Option<String>,
    #[serde(default)]
    timezone: Option<String>,
}

impl Environment {
    fn resolve(mut self, workspace: Option<&str>) -> Result<Self, String> {
        if let Some(timezone) = self.timezone.as_deref()
            && bridge::local_date(timezone).is_none()
        {
            return Err(format!("unknown timezone {timezone}"));
        }
        match (self.cwd.as_deref(), workspace) {
            (Some(cwd), Some(workspace)) if cwd != workspace => Err(format!(
                "environment.cwd {cwd} differs from workspace {workspace}, where the workspace tools run"
            )),
            (None, Some(workspace)) => {
                self.cwd = Some(workspace.to_owned());
                Ok(self)
            }
            _ => Ok(self),
        }
    }

    fn codex(&self) -> ExecutionEnvironment {
        let timezone: Arc<str> = self.timezone.as_deref().unwrap_or("Etc/UTC").into();
        let zone = Arc::clone(&timezone);
        let mut environment = ExecutionEnvironment::dated(timezone, move || {
            bridge::local_date(&zone).unwrap_or_default()
        });
        if let Some(cwd) = &self.cwd {
            environment = environment.working_directory(cwd.as_str());
        }
        if let Some(shell) = &self.shell {
            environment = environment.shell(shell.as_str());
        }
        environment
    }

    fn claude(&self) -> ClaudeEnvironment {
        let mut environment = ClaudeEnvironment::new();
        if let Some(cwd) = &self.cwd {
            environment = environment.working_directory(cwd.as_str());
        }
        if let Some(shell) = &self.shell {
            environment = environment.shell(shell.as_str());
        }
        environment
    }
}

impl Configuration {
    fn model(&self) -> Result<ModelSelection, String> {
        let Some(model) = &self.model else {
            return Ok(self.provider.model());
        };
        let selection = match self.provider {
            Provider::Claude => model.parse::<ClaudeModel>().map_or_else(
                |_| ModelSelection::new(HarnessFamily::Claude, model.as_str()),
                ModelSelection::Claude,
            ),
            Provider::Codex => model
                .parse::<Model>()
                .map(ModelSelection::Codex)
                .map_err(|error| format!("model {model}: {error}"))?,
        };
        selection
            .validate()
            .map_err(|error| format!("model {model}: {error}"))?;
        Ok(selection)
    }

    fn thinking(&self) -> Result<Option<Thinking>, String> {
        self.thinking.as_deref().map(str::parse).transpose()
    }

    fn endpoints(&mut self) -> Result<(Option<Endpoint>, Option<Endpoint>), String> {
        let root = Endpoint {
            endpoint: std::mem::take(&mut self.endpoint),
            subscription: self.subscription,
            gateway: self.gateway,
            cloudflare_account_id: self.cloudflare_account_id.take(),
            max_tokens: self.max_tokens,
            instructions: None,
        };
        let Providers { claude, codex } = std::mem::take(&mut self.providers);
        match self.provider {
            Provider::Claude if claude.is_some() => {
                Err("providers.claude names the session's own provider, which the top-level fields configure".into())
            }
            Provider::Codex if codex.is_some() => {
                Err("providers.codex names the session's own provider, which the top-level fields configure".into())
            }
            Provider::Claude => Ok((Some(root), codex)),
            Provider::Codex => Ok((claude, Some(root))),
        }
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
struct Annotation {
    #[serde(default)]
    request_id: Option<String>,
    event: Box<RawValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Command {
    HandOpen {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        workspace: Option<String>,
        #[serde(default)]
        max_frame_bytes: Option<usize>,
        #[serde(default)]
        tools: Vec<tools::HostTool>,
        #[serde(default)]
        mcp_servers: Vec<mcp::Server>,
    },
    HandFrame {
        text: String,
    },
    HandClosed {},
    Configure {
        #[serde(default)]
        value_limit: Option<usize>,
        #[serde(default)]
        logical_limit: Option<usize>,
        #[serde(default)]
        blob_threshold: Option<usize>,
    },
    Init {
        config: Value,
    },
    Submit {
        scope: String,
        request_id: String,
        prompt: String,
        #[serde(default)]
        images: Vec<String>,
        #[serde(default)]
        hand: Option<String>,
        metadata: Value,
    },
    Append {
        scope: String,
        events: Vec<Annotation>,
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
        #[serde(default)]
        max_bytes: Option<usize>,
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
    Compact {},
    Preconnect {},
    Settings {
        #[serde(default)]
        thinking: Option<String>,
        #[serde(default)]
        service_tier: Option<ServiceTier>,
        apply: bool,
    },
    Steer {
        request_id: String,
        prompt: String,
        #[serde(default)]
        into: Option<String>,
    },
    Replace {
        scope: String,
        request_id: String,
        edit_id: String,
        text: String,
    },
    MoveQueued {
        request_id: String,
        #[serde(default)]
        into: Option<String>,
    },
    InterruptSubagent {
        agent_id: u64,
    },
    CloseSubagent {
        agent_id: u64,
    },
    CompletionOrigin {
        request_id: String,
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
    Models {},
    ExportBranch {
        session_id: String,
        at: branch::At,
    },
    ExportPage {
        session_id: String,
        export: BranchExport,
        cursor: BranchCursor,
        max_bytes: usize,
    },
    ImportBranch {
        session_id: String,
        export: BranchExport,
    },
    ImportPage {
        session_id: String,
        export: BranchExport,
        page: BranchPage,
    },
    PublishBranch {
        session_id: String,
        export: BranchExport,
    },
    ImportEvents {
        scope: String,
        after: u64,
        events: Vec<LoggedEvent>,
    },
}

type Log = SessionLog<store::WorkerStore>;

type Hand = (String, Arc<dyn CodeModeHost>);

#[derive(Clone, Copy, PartialEq)]
enum Activity {
    Idle,
    Driving,
    Compacting,
}

struct Session {
    activity: Cell<Activity>,
    executors: CodeModeExecutors,
    hand_tools: Option<Arc<remote::ToolSelections>>,
    hands: RefCell<HashMap<String, Hand>>,
    inbox: TurnInbox<store::WorkerStore>,
    model: ModelSelection,
    scope: String,
    subagents: Option<SubagentControl>,
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
    static LOGICAL_LIMIT: Cell<Option<usize>> = const { Cell::new(None) };
    static VALUE_LIMIT: Cell<Option<usize>> = const { Cell::new(None) };
    static BLOB_THRESHOLD: Cell<Option<usize>> = const { Cell::new(None) };
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WebSearch {
    All(bool),
    Providers {
        #[serde(default = "enabled")]
        claude: bool,
        #[serde(default = "enabled")]
        codex: bool,
    },
}

impl Default for WebSearch {
    fn default() -> Self {
        Self::All(true)
    }
}

impl WebSearch {
    const fn enabled(&self, provider: Provider) -> bool {
        match (self, provider) {
            (Self::All(enabled), _) => *enabled,
            (Self::Providers { claude, .. }, Provider::Claude) => *claude,
            (Self::Providers { codex, .. }, Provider::Codex) => *codex,
        }
    }
}

const fn enabled() -> bool {
    true
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
            let log = match VALUE_LIMIT.get() {
                Some(limit) => log.value_limit(limit),
                None => log,
            };
            let log = match LOGICAL_LIMIT.get() {
                Some(limit) => log.logical_limit(limit),
                None => log,
            };
            Arc::new(match BLOB_THRESHOLD.get() {
                Some(threshold) => log.blobs(Arc::new(store::WorkerBlobs), threshold),
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

const CLAUDE_AUTO_COMPACT_WINDOW_TOKENS: u64 = 200_000;

const CLAUDE_COMPACT_RESERVE_TOKENS: u64 = 33_000;

fn claude_harness(
    endpoint: Endpoint,
    stream_tool_input: bool,
    auto_compact_window_tokens: u64,
    environment: Option<ClaudeEnvironment>,
    instructions: &dyn Fn(Option<&str>) -> String,
) -> (ClaudeHarness, ClaudeClient) {
    let http = nanocode::claude::transport::HttpClient::new(
        nanocode::claude::transport::SenderTransport(transport::WorkerTransport::CLAUDE),
    );
    let mut client =
        ClaudeClient::with_auth_headers(http, endpoint.endpoint, http::HeaderMap::new());
    if endpoint.subscription {
        client = client.subscription_compatibility();
    }
    let max_tokens = endpoint.max_tokens;
    let harness = ClaudeHarness::new(client.clone()).configure(move |claude| {
        let mut claude = claude
            .tool_input_deltas(stream_tool_input)
            .auto_compact_window_tokens(auto_compact_window_tokens);
        if let Some(environment) = &environment {
            claude = claude.environment(environment.clone());
        }
        Ok(match max_tokens {
            Some(max_tokens) => claude.max_tokens(max_tokens),
            None => claude,
        })
    });
    let harness = match endpoint.instructions.as_deref() {
        Some(application) => harness.instructions(instructions(Some(application))),
        None => harness,
    };
    (harness, client)
}

fn codex_harness(
    endpoint: Endpoint,
    model: Model,
    stream_tool_input: bool,
    environment: Option<ExecutionEnvironment>,
    instructions: &dyn Fn(Option<&str>) -> String,
) -> Result<CodexHarness, Opening> {
    let openai = match (endpoint.subscription, endpoint.gateway) {
        (true, Some(Gateway::Vercel)) => {
            return Err(configuration(
                "the Vercel AI Gateway serves Codex API-key sessions, not ChatGPT subscriptions",
            ));
        }
        (true, Some(Gateway::WorkersAi)) => {
            return Err(configuration(
                "Workers AI serves Codex API-key sessions, not ChatGPT subscriptions",
            ));
        }
        (false, Some(Gateway::WorkersAi)) => {
            let Some(account_id) = endpoint
                .cloudflare_account_id
                .as_deref()
                .filter(|account| !account.trim().is_empty())
            else {
                return Err(configuration(
                    "the Workers AI gateway needs cloudflare_account_id",
                ));
            };
            OpenAi::builder(OpenAiAuth::gateway_managed())
                .chat_gateway(ChatGateway::workers_ai(account_id))
        }
        (true, None) => OpenAi::builder(OpenAiAuth::host_managed_chatgpt())
            .transport(ResponsesTransport::WebSocket)
            .websocket_warmup(false),
        (false, Some(Gateway::Vercel)) => OpenAi::builder(OpenAiAuth::gateway_managed())
            .responses_gateway(ResponsesGateway::vercel()),
        (false, None) => {
            OpenAi::builder(OpenAiAuth::gateway_managed()).transport(ResponsesTransport::Https)
        }
    };
    let openai = match endpoint.gateway {
        Some(Gateway::WorkersAi) => openai,
        _ => openai.api_base_url(endpoint.endpoint),
    };
    let client = openai
        .model(model)
        .tool_input_deltas(stream_tool_input)
        .host_transport(transport::WorkerTransport::CODEX)
        .build()
        .map_err(configuration)?;
    let harness = CodexHarness::new(client).configure(move |codex| {
        Ok(match &environment {
            Some(environment) => codex.execution_environment(environment.clone()),
            None => codex,
        })
    });
    Ok(match endpoint.instructions.as_deref() {
        Some(application) => harness.instructions(instructions(Some(application))),
        None => harness,
    })
}

async fn open(mut config: Configuration) -> Result<Session, Opening> {
    let coalesce = Duration::from_millis(config.event_coalesce_ms);
    let store =
        nanocode::session_store(SqlStore::new(store::WorkerStore::durability())).map_err(text)?;
    let model = config.model().map_err(configuration)?;
    let thinking = config.thinking().map_err(configuration)?;
    if config.code_mode && config.remote {
        return Err(configuration(
            "code_mode runs cells in this host; leave remote unset",
        ));
    }
    if let Some(policy) = &config.hand_tools
        && let Some(backend) = policy
            .keys()
            .find(|backend| !matches!(backend.as_str(), "codex" | "claude"))
    {
        return Err(configuration(format!(
            "unsupported hand_tools backend: {backend}"
        )));
    }
    let placement = config.remote || config.hands;
    let local = config.code_mode;
    let instructions = |application: Option<&str>| {
        [
            application,
            placement.then_some(PLACEMENT_INSTRUCTIONS),
            local.then_some(LOCAL_INSTRUCTIONS),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n\n")
    };
    let environment = config
        .environment
        .take()
        .map(|environment| environment.resolve(config.workspace.as_deref()))
        .transpose()
        .map_err(configuration)?;
    let (claude, codex) = config.endpoints().map_err(configuration)?;
    let claude_search_tokens = claude.as_ref().map(|endpoint| endpoint.max_tokens);
    let claude = claude.map(|endpoint| {
        claude_harness(
            endpoint,
            config.stream_tool_input,
            config
                .auto_compact_window_tokens
                .unwrap_or(CLAUDE_AUTO_COMPACT_WINDOW_TOKENS),
            environment.as_ref().map(Environment::claude),
            &instructions,
        )
    });
    let codex_search = codex
        .as_ref()
        .filter(|endpoint| !matches!(endpoint.gateway, Some(Gateway::WorkersAi)))
        .map(|endpoint| {
            (
                endpoint.endpoint.clone(),
                matches!(endpoint.gateway, Some(Gateway::Vercel))
                    .then(|| ResponsesGateway::vercel().model_id_prefix())
                    .flatten(),
            )
        });
    let codex = match codex {
        Some(endpoint) => {
            let default = match config.provider {
                Provider::Codex => model.as_codex(),
                Provider::Claude => Some(Model::Sol),
            };
            let Some(default) = default else {
                return Err(configuration(format!("{model} is not a Codex model")));
            };
            Some(codex_harness(
                endpoint,
                default,
                config.stream_tool_input,
                environment.as_ref().map(Environment::codex),
                &instructions,
            )?)
        }
        None => None,
    };
    let executors = CodeModeExecutors::new();
    let hand_tools = config
        .hand_tools
        .map(|policy| Arc::new(remote::ToolSelections(policy)));
    let mut shared: Vec<Arc<dyn Tool>> = Vec::new();
    if placement {
        shared.push(Arc::new(executors.tool()));
    }
    shared.extend(
        mcp::tools(config.mcp_servers)
            .await
            .map_err(|failure| match failure {
                mcp::Failure::Configuration(error) => configuration(error),
                mcp::Failure::Unavailable(error) => Opening::Failed(error),
            })?
            .into_iter()
            .map(|tool| Arc::new(tool) as Arc<dyn Tool>),
    );
    let claude_client = claude.as_ref().map(|(_, client)| client.clone());
    let host_tool = |name: &str| {
        config
            .tools
            .iter()
            .any(|tool| tool.name() == name || tool.name() == "web_search")
    };
    let host_search = [host_tool("WebSearch"), host_tool("web__run")];
    shared.extend(tools::tools(config.tools).map(|tool| Arc::new(tool) as Arc<dyn Tool>));
    let search = |family: Provider| -> Option<Arc<dyn Tool>> {
        let replaced = match family {
            Provider::Claude => host_search[0],
            Provider::Codex => host_search[1],
        };
        if !config.web_search.enabled(family) || replaced {
            return None;
        }
        match family {
            Provider::Claude => claude_client.as_ref().map(|client| {
                Arc::new(nanocode::claude::web_search_tool(
                    client.clone(),
                    claude_search_tokens.flatten(),
                )) as Arc<dyn Tool>
            }),
            Provider::Codex => codex_search.as_ref().map(|(endpoint, prefix)| {
                Arc::new(nanocode::codex_tools::web_search_tool(
                    endpoint,
                    *prefix,
                    Arc::new(transport::WorkerTransport::CODEX),
                )) as Arc<dyn Tool>
            }),
        }
    };
    let selected = |family: Provider| -> Result<Tools, Opening> {
        let base = match config.workspace.as_deref() {
            Some(root) => match family {
                Provider::Claude => nanocode::claude::host_tools(
                    root.into(),
                    Arc::new(workspace::HostFiles),
                    Arc::new(workspace::HostShell),
                ),
                Provider::Codex => nanocode::codex_tools::host_tools(
                    root.into(),
                    Arc::new(workspace::HostFiles),
                    Arc::new(workspace::HostShell),
                ),
            },
            None => Tools::builder().without_defaults().build(),
        }
        .map_err(configuration)?;
        let tools = shared
            .iter()
            .cloned()
            .chain(search(family))
            .try_fold(base, |tools, tool| tools.add_shared_tool(tool))
            .map_err(configuration)?;
        if !(placement || local) {
            return Ok(tools);
        }
        tools
            .into_builder()
            .without_defaults()
            .code_mode_host(executors.clone())
            .build()
            .map_err(configuration)
    };
    let mut builder = Nanocode::builder();
    if BLOB_THRESHOLD.get().is_some() {
        builder = builder.images(
            nanocode::ImageHistory::default().with_blob_store(Arc::new(store::WorkerBlobs)),
        );
    }
    if let Some((harness, _)) = claude {
        builder = builder.claude(harness.tools(selected(Provider::Claude)?));
    }
    if let Some(harness) = codex {
        builder = builder.openai(harness.tools(selected(Provider::Codex)?));
    }
    if config.subagents == Some(false) {
        builder = builder.without_subagents();
    }
    builder = builder
        .workspace(config.workspace.as_deref().unwrap_or("/"))
        .durability(store.clone());
    if config.remote || local {
        let name: Arc<str> = config
            .executor
            .as_deref()
            .unwrap_or(if local { "local" } else { "default" })
            .into();
        let host: Arc<dyn CodeModeHost> = if local {
            Arc::new(cells::host(config.workspace.as_deref()))
        } else {
            let host = remote::host(None).await?;
            Arc::new(match &hand_tools {
                Some(policy) => host.with_tool_selection(policy.clone()),
                None => host,
            })
        };
        executors.insert(Arc::clone(&name), host);
        executors.set_default(Some(name));
    }
    let session_instructions = instructions(config.instructions.as_deref());
    if !session_instructions.is_empty() {
        builder = builder.instructions(session_instructions);
    }
    let runtime = builder
        .build()
        .map_err(|error| configuration(format!("build runtime: {error}")))?;
    let subagents = runtime.subagents().cloned();
    let host = Arc::new(events::WorkerInbox::new(
        config.runtime_id,
        config.started_ms,
        executors.clone(),
    ));
    let mut record = SessionRecord::root(&config.session_id, model.clone(), None);
    record.initial =
        (thinking.is_some() || config.service_tier.is_some()).then(|| InitialSettings {
            thinking: thinking.unwrap_or_else(|| model.default_thinking()),
            service_tier: config.service_tier.unwrap_or_default(),
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
                activity: Cell::new(Activity::Idle),
                executors,
                hand_tools,
                hands: RefCell::default(),
                inbox,
                model,
                scope: config.scope,
                subagents,
            })
        }
        Err(error) => {
            let _ = runtime.shutdown().await;
            Err(match error {
                InboxError::Agent(NanocodeError::InvalidRequest(_)) => {
                    Opening::Configuration(error.to_string())
                }
                error => Opening::Failed(error.to_string()),
            })
        }
    }
}

async fn init(config: Value) -> Result<Value, String> {
    let config = match serde_json::from_value::<Configuration>(config) {
        Ok(config) => config,
        Err(error) => {
            return Ok(
                json!({"rejected": {"error": format!("configuration: {error}"), "kind": "configuration"}}),
            );
        }
    };
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
        let host = remote::host(Some(connection.clone())).await?;
        let host: Arc<dyn CodeModeHost> = Arc::new(match &self.hand_tools {
            Some(policy) => host.with_tool_selection(policy.clone()),
            None => host,
        });
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

    fn subagents(&self) -> Result<&SubagentControl, String> {
        self.subagents
            .as_ref()
            .ok_or_else(|| "the session has no subagents".into())
    }

    async fn drive(&self, next: Option<&str>) -> Result<Value, String> {
        if self.activity.get() != Activity::Idle {
            return Ok(json!({"waiting": true, "busy": true}));
        }
        self.activity.set(Activity::Driving);
        let driven = self.inbox.drive(next).await;
        self.activity.set(Activity::Idle);
        Ok(match driven.map_err(text)? {
            Driven::Idle => json!({"idle": true}),
            Driven::Busy => json!({"waiting": true, "busy": true}),
            Driven::Finished(record) => json!({"finished": described(&record)?}),
            Driven::Resumed(request_id) => json!({"resumed": request_id}),
            Driven::Waiting(request_id) => json!({"waiting": true, "request_id": request_id}),
            Driven::Interrupted(request_id) => json!({"retry": true, "request_id": request_id}),
        })
    }
}

impl Session {
    async fn compact(&self) -> Result<Value, String> {
        if self.activity.get() != Activity::Idle {
            return Ok(json!({"busy": true}));
        }
        self.activity.set(Activity::Compacting);
        let compacted = self.compacting().await;
        self.activity.set(Activity::Idle);
        compacted
    }

    async fn compacting(&self) -> Result<Value, String> {
        let admitted = !self.inbox.log().pending().await.map_err(text)?.is_empty();
        if admitted || !self.inbox.settle().await.map_err(text)? {
            return Ok(json!({"busy": true}));
        }
        self.inbox.agent().compact().await.map_err(text)?;
        self.inbox.settle().await.map_err(text)?;
        Ok(json!({"compacted": true}))
    }
}

async fn submit(
    scope: &str,
    request_id: String,
    prompt: String,
    images: Vec<String>,
    hand: Option<String>,
    metadata: &Value,
) -> Result<Value, String> {
    let prompt = if images.is_empty() {
        Prompt::from(prompt)
    } else {
        Prompt::content(std::iter::once(UserInput::Text { text: prompt }).chain(
            images.into_iter().map(|image_url| UserInput::Image {
                image_url,
                detail: None,
            }),
        ))
    };
    let submission = Submission {
        request_id,
        prompt,
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

async fn append(scope: &str, events: Vec<Annotation>) -> Result<Value, String> {
    let log = log(scope);
    let mut entries = Vec::with_capacity(events.len());
    for Annotation { request_id, event } in events {
        let described = serde_json::from_str::<Value>(event.get()).map_err(text)?;
        match described.get("source").and_then(Value::as_str) {
            Some("agent" | "subagent") => {
                return Err("sources agent and subagent belong to the SDK's events".into());
            }
            Some(_) => {}
            None => return Err("a host event is an object with a string source".into()),
        }
        if let Some(request_id) = &request_id
            && log.turn(request_id).await.map_err(text)?.is_none()
        {
            return Err(format!("turn {request_id} is not in the log"));
        }
        entries.push(LogEntry { request_id, event });
    }
    let logged = log.append(&entries).await.map_err(text)?;
    events::publish(logged.clone()).await?;
    Ok(json!({"appended": logged}))
}

async fn replace(
    scope: &str,
    request_id: &str,
    edit_id: &str,
    edited: &str,
) -> Result<Value, String> {
    let status = match log(scope)
        .replace_queued(request_id, edit_id, edited)
        .await
        .map_err(text)?
    {
        Replaced::Applied(Some(event)) => {
            events::publish(vec![event]).await?;
            "applied"
        }
        Replaced::Applied(None) => "already_applied",
        Replaced::NotQueued => "not_queued",
        Replaced::Conflict => "conflict",
        Replaced::TooLarge { bytes, limit } => {
            return Ok(json!({"replaced": "too_large", "bytes": bytes, "limit": limit}));
        }
    };
    Ok(json!({"replaced": status}))
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

fn models() -> Value {
    let entry = |id: &str,
                 model: ModelSelection,
                 gateways: Vec<&str>,
                 context_window_tokens: u64,
                 auto_compact_limit: Option<u64>| {
        let capabilities = model.capabilities(ModelTransport::Native);
        json!({
            "id": id,
            "name": capabilities.display_name(),
            "efforts": capabilities.thinking().map(Thinking::as_str).collect::<Vec<_>>(),
            "effort": capabilities.default_thinking().as_str(),
            "priority": capabilities.supports_service_tier(ServiceTier::Priority),
            "service_tiers": capabilities.service_tiers().map(ServiceTier::as_str).collect::<Vec<_>>(),
            "reasoning_modes": capabilities.reasoning_modes().map(ReasoningMode::as_str).collect::<Vec<_>>(),
            "gateways": gateways,
            "context_window_tokens": context_window_tokens,
            "auto_compact_token_limit": auto_compact_limit,
        })
    };
    let claude = HarnessFamily::Claude
        .models()
        .map(|model| {
            let window = nanocode::claude::default_context_window_tokens(model.as_str());
            entry(
                model.as_str(),
                model.clone(),
                vec!["direct", "vercel"],
                window,
                Some(
                    window
                        .min(CLAUDE_AUTO_COMPACT_WINDOW_TOKENS)
                        .saturating_sub(CLAUDE_COMPACT_RESERVE_TOKENS),
                ),
            )
        })
        .collect::<Vec<_>>();
    let vercel = ResponsesGateway::vercel();
    let workers_ai = ChatGateway::workers_ai("catalog");
    let codex = Model::ALL
        .into_iter()
        .chain([Model::Glm53, Model::Kimi, Model::Mimo])
        .map(|model| {
            let gateways = [
                (Model::ALL.contains(&model), "direct"),
                (vercel.serves(model), "vercel"),
                (workers_ai.serves_model(model), "workers_ai"),
            ]
            .into_iter()
            .filter_map(|(serves, gateway)| serves.then_some(gateway))
            .collect();
            let id = match model {
                Model::Glm53 => "glm-5.3",
                _ => model.as_str(),
            };
            let window = CONTEXT_WINDOW_TOKENS.min(model.max_context_window_tokens());
            entry(
                id,
                ModelSelection::Codex(model),
                gateways,
                window,
                auto_compact_token_limit(model.as_str(), window),
            )
        })
        .collect::<Vec<_>>();
    json!({"harnesses": [
        {"id": "claude", "models": claude},
        {"id": "codex", "models": codex},
    ]})
}

fn executed<T: Serialize>(future: impl Future<Output = Result<T, String>> + 'static) -> Executed {
    Box::pin(async move { raw(&future.await?) })
}

fn execute(command: Command) -> Executed {
    match command {
        Command::HandOpen {
            name,
            workspace,
            max_frame_bytes,
            tools,
            mcp_servers,
        } => executed(async move {
            hand::open(name, workspace, max_frame_bytes, tools, mcp_servers).await
        }),
        Command::HandFrame { text } => executed(async move { hand::receive(&text) }),
        Command::HandClosed {} => executed(async move {
            hand::closed();
            Ok(Value::Null)
        }),
        Command::Configure {
            value_limit,
            logical_limit,
            blob_threshold,
        } => executed(async move {
            VALUE_LIMIT.set(value_limit);
            LOGICAL_LIMIT.set(logical_limit);
            BLOB_THRESHOLD.set(blob_threshold);
            Ok(Value::Null)
        }),
        Command::Init { config } => executed(init(config)),
        Command::Submit {
            scope,
            request_id,
            prompt,
            images,
            hand,
            metadata,
        } => executed(
            async move { submit(&scope, request_id, prompt, images, hand, &metadata).await },
        ),
        Command::Append { scope, events } => executed(async move { append(&scope, events).await }),
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
            max_bytes,
        } => executed(async move {
            let log = log(&scope);
            match (request_id, max_bytes) {
                (Some(request_id), Some(bytes)) => {
                    log.turn_page_bounded(&request_id, after, limit, bytes)
                        .await
                }
                (Some(request_id), None) => log.turn_page(&request_id, after, limit).await,
                (None, Some(bytes)) => log.page_bounded(after, limit, bytes).await,
                (None, None) => log.page(after, limit).await,
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
        Command::Compact {} => executed(async move { ready()?.compact().await }),
        Command::Models {} => executed(async move { Ok(models()) }),
        Command::Preconnect {} => executed(async move {
            ready()?.inbox.agent().preconnect().await.map_err(text)?;
            Ok(Value::Null)
        }),
        Command::Settings {
            thinking,
            service_tier,
            apply,
        } => executed(async move {
            let thinking = thinking
                .map(|thinking| thinking.parse::<Thinking>())
                .transpose()
                .map_err(text)?;
            let session = ready()?;
            let capabilities = session.model.capabilities(ModelTransport::Native);
            if let Some(thinking) = thinking {
                capabilities.check_thinking(thinking).map_err(text)?;
            }
            if let Some(service_tier) = service_tier {
                capabilities
                    .check_service_tier(service_tier)
                    .map_err(text)?;
            }
            if apply {
                let agent = session.inbox.agent();
                if let Some(thinking) = thinking {
                    agent.set_thinking(thinking).await.map_err(text)?;
                }
                if let Some(service_tier) = service_tier {
                    agent.set_service_tier(service_tier).await.map_err(text)?;
                }
            }
            Ok(Value::Null)
        }),
        Command::Steer {
            request_id,
            prompt,
            into,
        } => executed(async move {
            let steered = ready()?
                .inbox
                .steer(into.as_deref(), &request_id, Prompt::from(prompt))
                .await
                .map_err(text)?;
            Ok(Value::Bool(steered))
        }),
        Command::InterruptSubagent { agent_id } => executed(async move {
            let session = ready()?;
            session
                .subagents()?
                .interrupt(session.inbox.session_id(), AgentId::new(agent_id))
                .await
                .map_err(text)
        }),
        Command::CloseSubagent { agent_id } => executed(async move {
            let session = ready()?;
            session
                .subagents()?
                .close(session.inbox.session_id(), AgentId::new(agent_id))
                .await
                .map_err(text)
        }),
        Command::CompletionOrigin { request_id } => executed(async move {
            let origin = match &ready()?.subagents {
                Some(subagents) => subagents.completion_origin(&request_id).await,
                None => None,
            };
            Ok(json!(origin.as_deref()))
        }),
        Command::Replace {
            scope,
            request_id,
            edit_id,
            text: edited,
        } => executed(async move { replace(&scope, &request_id, &edit_id, &edited).await }),
        Command::MoveQueued { request_id, into } => executed(async move {
            let moved = ready()?
                .inbox
                .move_queued(&request_id, into.as_deref())
                .await
                .map_err(text)?;
            Ok(json!({"moved": match moved {
                MovedQueued::Moved => "moved",
                MovedQueued::NotQueued => "not_queued",
                MovedQueued::NotRunning => "not_running",
                MovedQueued::Conflict => "conflict",
                MovedQueued::Unknown => "unknown",
            }}))
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
        Command::ExportBranch { session_id, at } => {
            executed(async move { branch::export(&session_id, at).await })
        }
        Command::ExportPage {
            session_id,
            export,
            cursor,
            max_bytes,
        } => executed(async move { branch::page(&session_id, &export, cursor, max_bytes).await }),
        Command::ImportBranch { session_id, export } => executed(async move {
            let next = branch::import(&session_id, export, None).await?;
            Ok(json!({"next": next}))
        }),
        Command::ImportPage {
            session_id,
            export,
            page,
        } => executed(async move {
            let next = branch::import(&session_id, export, Some(&page)).await?;
            Ok(json!({"next": next}))
        }),
        Command::PublishBranch { session_id, export } => {
            executed(async move { branch::publish(&session_id, &export).await })
        }
        Command::ImportEvents {
            scope,
            after,
            events,
        } => executed(async move {
            log(&scope)
                .import_events(after, &events)
                .await
                .map(Value::from)
                .map_err(text)
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
