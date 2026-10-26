use std::path::Path;

use nanocode::process::{
    ExecCommand, ExecCommandResult, FileHost, ForegroundCommand, ForegroundExecutor,
    ForegroundOutput, ProcessFuture, ShellExecutor, WriteStdin, effective_token_limit,
    redact_and_limit,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::bridge::{call, call_bytes_with, call_with_body, monotonic_ms};

pub struct HostFiles;

pub struct HostShell;

#[derive(Deserialize)]
struct Ran {
    stdout: String,
    stderr: String,
    exit_code: i32,
    truncated: bool,
}

fn failure(error: Value) -> String {
    error
        .get("detail")
        .and_then(Value::as_str)
        .map_or_else(|| error.to_string(), str::to_owned)
}

fn text(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("{} is not UTF-8", path.display()))
}

async fn run(script: &str, cwd: &Path, timeout_ms: Option<u64>) -> Result<Ran, String> {
    let reply = call(json!({
        "op": "shell_run",
        "command": script,
        "cwd": text(cwd)?,
        "timeout_ms": timeout_ms,
    }))
    .await
    .map_err(failure)?;
    serde_json::from_value(reply).map_err(|error| format!("shell_run reply: {error}"))
}

impl FileHost for HostFiles {
    fn read<'a>(&'a self, path: &'a Path) -> ProcessFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            match call(json!({"op": "file_read", "path": text(path)?}))
                .await
                .map_err(failure)?
            {
                Value::Null => Ok(None),
                Value::String(contents) => Ok(Some(contents)),
                other => Err(format!("file_read returned {other}")),
            }
        })
    }

    fn write<'a>(
        &'a self,
        path: &'a Path,
        contents: &'a str,
    ) -> ProcessFuture<'a, Result<(), String>> {
        Box::pin(async move {
            call(json!({"op": "file_write", "path": text(path)?, "contents": contents}))
                .await
                .map(drop)
                .map_err(failure)
        })
    }

    fn read_bytes<'a>(
        &'a self,
        path: &'a Path,
    ) -> ProcessFuture<'a, Result<Option<Vec<u8>>, String>> {
        Box::pin(async move {
            let path = text(path)?;
            if call(json!({"op": "file_exists", "path": path}))
                .await
                .map_err(failure)?
                != Value::Bool(true)
            {
                return Ok(None);
            }
            call_bytes_with(&json!({"op": "cell_read", "path": path, "cwd": "/"}))
                .await
                .map(Some)
                .map_err(failure)
        })
    }

    fn write_bytes<'a>(
        &'a self,
        path: &'a Path,
        bytes: &'a [u8],
    ) -> ProcessFuture<'a, Result<(), String>> {
        Box::pin(async move {
            call_with_body(
                json!({"op": "cell_write", "path": text(path)?, "cwd": "/", "append": false}),
                bytes,
            )
            .await
            .map(drop)
            .map_err(failure)
        })
    }

    fn remove<'a>(&'a self, path: &'a Path) -> ProcessFuture<'a, Result<(), String>> {
        Box::pin(async move {
            call(json!({"op": "file_remove", "path": text(path)?}))
                .await
                .map(drop)
                .map_err(failure)
        })
    }
}

impl ForegroundExecutor for HostShell {
    fn execute<'a>(
        &'a self,
        command: ForegroundCommand<'a>,
    ) -> ProcessFuture<'a, Result<ForegroundOutput, String>> {
        Box::pin(async move {
            let ran = run(
                command.command,
                command.workspace,
                Some(u64::try_from(command.timeout.as_millis()).unwrap_or(u64::MAX)),
            )
            .await?;
            let (stdout, stdout_cut) = redact_and_limit(ran.stdout, &[], command.max_stdout);
            let (stderr, stderr_cut) = redact_and_limit(ran.stderr, &[], command.max_stderr);
            Ok(ForegroundOutput {
                stdout,
                stderr,
                exit_code: ran.exit_code,
                truncated: ran.truncated || stdout_cut || stderr_cut,
            })
        })
    }
}

impl ShellExecutor for HostShell {
    fn execute<'a>(
        &'a self,
        command: ExecCommand,
        workspace: &'a Path,
    ) -> ProcessFuture<'a, ExecCommandResult> {
        Box::pin(async move {
            let started = monotonic_ms();
            let cwd = command.workdir.as_deref().map_or_else(
                || workspace.to_path_buf(),
                |workdir| workspace.join(workdir),
            );
            let elapsed =
                || std::time::Duration::from_secs_f64((monotonic_ms() - started).max(0.0) / 1000.0);
            match run(&command.script, &cwd, None).await {
                Ok(ran) => {
                    let mut output = ran.stdout;
                    output.push_str(&ran.stderr);
                    let original = output.len().saturating_add(3) / 4;
                    let (output, _) = redact_and_limit(
                        output,
                        &[],
                        effective_token_limit(command.max_output_tokens),
                    );
                    ExecCommandResult {
                        error: None,
                        chunk_id: None,
                        wall_time_seconds: elapsed().as_secs_f64(),
                        exit_code: Some(ran.exit_code),
                        session_id: None,
                        original_token_count: Some(original),
                        output,
                    }
                }
                Err(error) => ExecCommandResult::failed(elapsed(), error),
            }
        })
    }

    fn write_stdin(&self, request: WriteStdin) -> ProcessFuture<'_, ExecCommandResult> {
        Box::pin(async move {
            ExecCommandResult::failed(
                std::time::Duration::ZERO,
                format!(
                    "session {} is not running: this host's commands finish before exec_command returns",
                    request.session_id
                ),
            )
        })
    }

    fn terminate_all(&self) -> ProcessFuture<'_, ()> {
        Box::pin(async {})
    }
}
