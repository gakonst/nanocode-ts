use std::{cell::RefCell, collections::HashMap};

use nanocode::durability::{
    BranchCursor, BranchExport, BranchImport, BranchPage, BranchPoint, SessionStore,
    SessionSummary, SqlStore,
};
use serde::Deserialize;

use super::{store::WorkerStore, text};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum At {
    Latest,
    Through(String),
    Before(String),
}

thread_local! {
    static SESSIONS: RefCell<Option<SessionStore>> = const { RefCell::new(None) };
    static IMPORTS: RefCell<HashMap<String, (BranchExport, BranchImport)>> = RefCell::new(HashMap::new());
}

fn sessions() -> Result<SessionStore, String> {
    if let Some(sessions) = SESSIONS.with_borrow(Clone::clone) {
        return Ok(sessions);
    }
    let sessions =
        nanocode::session_store(SqlStore::new(WorkerStore::durability())).map_err(text)?;
    SESSIONS.set(Some(sessions.clone()));
    Ok(sessions)
}

pub async fn export(session_id: &str, at: At) -> Result<BranchExport, String> {
    let at = match at {
        At::Latest => BranchPoint::Latest,
        At::Through(turn) => BranchPoint::Through(turn),
        At::Before(turn) => BranchPoint::Before(turn),
    };
    sessions()?
        .export_branch(session_id, at)
        .await
        .map_err(text)
}

pub async fn page(
    session_id: &str,
    export: &BranchExport,
    cursor: BranchCursor,
    max_bytes: usize,
) -> Result<BranchPage, String> {
    sessions()?
        .export_page(session_id, export, cursor, max_bytes)
        .await
        .map_err(text)
}

async fn opened(session_id: &str, export: &BranchExport) -> Result<BranchImport, String> {
    match IMPORTS.with_borrow_mut(|imports| imports.remove(session_id)) {
        Some((opened, import)) if opened == *export => Ok(import),
        _ => sessions()?
            .import_branch(session_id, export)
            .await
            .map_err(text),
    }
}

pub async fn import(
    session_id: &str,
    export: BranchExport,
    page: Option<&BranchPage>,
) -> Result<Option<BranchCursor>, String> {
    let mut import = opened(session_id, &export).await?;
    if let Some(page) = page {
        import.import(page).await.map_err(text)?;
    }
    let next = import.next();
    IMPORTS.with_borrow_mut(|imports| imports.insert(session_id.to_owned(), (export, import)));
    Ok(next)
}

pub async fn publish(session_id: &str, export: &BranchExport) -> Result<SessionSummary, String> {
    opened(session_id, export)
        .await?
        .publish()
        .await
        .map_err(text)
}
