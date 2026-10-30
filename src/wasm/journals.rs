use std::collections::BTreeMap;

use nanocode::durability::{Sql, SqlStatement};
use nanocode_code_mode::{
    code_mode::{CellJournal, CellJournalSink, CellJournalUpdate},
    embedded::HostFuture,
};

use super::store::WorkerStore;

const CREATE: &str = "CREATE TABLE IF NOT EXISTS nanocode_cell_journals (scope TEXT NOT NULL, session_id TEXT NOT NULL, cell_id INTEGER NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (session_id, cell_id, seq))";

const INSERT: &str = "INSERT OR REPLACE INTO nanocode_cell_journals (scope, session_id, cell_id, seq, body) VALUES (?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), ?)";

const CLEAR: &str =
    "DELETE FROM nanocode_cell_journals WHERE session_id = ? AND cell_id = CAST(? AS INTEGER)";

const SELECT: &str =
    "SELECT body FROM nanocode_cell_journals WHERE scope = ? ORDER BY session_id, cell_id, seq";

pub struct WorkerJournals {
    scope: String,
}

impl WorkerJournals {
    pub const fn new(scope: String) -> Self {
        Self { scope }
    }
}

impl CellJournalSink for WorkerJournals {
    fn save(&self, update: CellJournalUpdate) -> HostFuture<'static, Result<(), String>> {
        let scope = self.scope.clone();
        Box::pin(async move {
            let body = serde_json::to_string(&update).map_err(|error| error.to_string())?;
            let cell = update.cell_id.to_string();
            let seq = update.seq.to_string();
            let insert = SqlStatement {
                sql: INSERT,
                params: vec![&scope, &update.session_id, &cell, &seq, &body],
            };
            let statements = if update.header.is_some() {
                vec![
                    SqlStatement {
                        sql: CLEAR,
                        params: vec![&update.session_id, &cell],
                    },
                    insert,
                ]
            } else {
                vec![insert]
            };
            WorkerStore::durability()
                .transaction("cell_journal_save", &statements)
                .await
                .map(drop)
                .map_err(|error| error.to_string())
        })
    }

    fn forget(&self, session_id: &str, cell_id: u64) -> HostFuture<'static, ()> {
        let session_id = session_id.to_owned();
        Box::pin(async move {
            let cell = cell_id.to_string();
            let _ = WorkerStore::durability()
                .transaction(
                    "cell_journal_forget",
                    &[SqlStatement {
                        sql: CLEAR,
                        params: vec![&session_id, &cell],
                    }],
                )
                .await;
        })
    }
}

pub async fn load(scope: &str) -> Result<BTreeMap<String, Vec<CellJournal>>, String> {
    let rows = WorkerStore::durability()
        .transaction(
            "cell_journal_load",
            &[
                SqlStatement {
                    sql: CREATE,
                    params: Vec::new(),
                },
                SqlStatement {
                    sql: SELECT,
                    params: vec![scope],
                },
            ],
        )
        .await
        .map_err(|error| error.to_string())?;
    let mut cells: BTreeMap<(String, u64), Vec<CellJournalUpdate>> = BTreeMap::new();
    for row in rows.get(1).into_iter().flatten() {
        let Some(Some(body)) = row.first() else {
            continue;
        };
        let Ok(update) = serde_json::from_str::<CellJournalUpdate>(body) else {
            continue;
        };
        cells
            .entry((update.session_id.clone(), update.cell_id))
            .or_default()
            .push(update);
    }
    let mut sessions: BTreeMap<String, Vec<CellJournal>> = BTreeMap::new();
    for ((session_id, _), updates) in cells {
        if let Some(journal) = CellJournal::fold(updates) {
            sessions.entry(session_id).or_default().push(journal);
        }
    }
    Ok(sessions)
}
