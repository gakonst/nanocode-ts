use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap},
};

use nanocode::durability::{Sql, SqlStatement};
use nanocode_code_mode::{
    code_mode::{CellJournal, CellJournalSink, CellJournalUpdate},
    embedded::HostFuture,
};

use super::store::WorkerStore;

const APPEND: &str = "UPDATE nanocode_cell_journal_batches SET body = body || char(10) || ? WHERE session_id = ? AND cell_id = CAST(? AS INTEGER) AND seq = CAST(? AS INTEGER)";

const CLEAR: &str = "DELETE FROM nanocode_cell_journal_batches WHERE session_id = ? AND cell_id = CAST(? AS INTEGER)";

const CLEAR_UPDATES: &str =
    "DELETE FROM nanocode_cell_journals WHERE session_id = ? AND cell_id = CAST(? AS INTEGER)";

const CREATE: &str = "CREATE TABLE IF NOT EXISTS nanocode_cell_journals (scope TEXT NOT NULL, session_id TEXT NOT NULL, cell_id INTEGER NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (session_id, cell_id, seq))";

const CREATE_BATCHES: &str = "CREATE TABLE IF NOT EXISTS nanocode_cell_journal_batches (scope TEXT NOT NULL, session_id TEXT NOT NULL, cell_id INTEGER NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (session_id, cell_id, seq))";

const INSERT: &str = "INSERT OR REPLACE INTO nanocode_cell_journal_batches (scope, session_id, cell_id, seq, body) VALUES (?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), ?)";

const LEAF_PAYLOAD_BYTES: usize = 4096 - 35;

const RECORD_FIXED_BYTES: usize = 6 * 9 + 2 * 8;

const SELECT: &str = "SELECT body FROM nanocode_cell_journals WHERE scope = ? UNION ALL SELECT body FROM nanocode_cell_journal_batches WHERE scope = ?";

thread_local! {
    static BATCHES: RefCell<HashMap<(String, u64), (u64, usize)>> = RefCell::new(HashMap::new());
}

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
            let key = (update.session_id.clone(), update.cell_id);
            let room = LEAF_PAYLOAD_BYTES
                .saturating_sub(RECORD_FIXED_BYTES + scope.len() + update.session_id.len());
            let open = BATCHES
                .with_borrow(|batches| batches.get(&key).copied())
                .filter(|&(_, bytes)| update.header.is_none() && bytes + 1 + body.len() <= room);
            let (seq, bytes) = match open {
                Some((seq, bytes)) => (seq, bytes + 1 + body.len()),
                None => (update.seq, body.len()),
            };
            let first = seq.to_string();
            let mut statements = Vec::new();
            if update.header.is_some() {
                statements.push(SqlStatement {
                    sql: CLEAR,
                    params: vec![&update.session_id, &cell],
                });
                statements.push(SqlStatement {
                    sql: CLEAR_UPDATES,
                    params: vec![&update.session_id, &cell],
                });
            }
            statements.push(match open {
                Some(_) => SqlStatement {
                    sql: APPEND,
                    params: vec![&body, &update.session_id, &cell, &first],
                },
                None => SqlStatement {
                    sql: INSERT,
                    params: vec![&scope, &update.session_id, &cell, &first, &body],
                },
            });
            WorkerStore::durability()
                .transaction("cell_journal_save", &statements)
                .await
                .map_err(|error| error.to_string())?;
            BATCHES.with_borrow_mut(|batches| batches.insert(key, (seq, bytes)));
            Ok(())
        })
    }

    fn forget(&self, session_id: &str, cell_id: u64) -> HostFuture<'static, ()> {
        let session_id = session_id.to_owned();
        Box::pin(async move {
            BATCHES.with_borrow_mut(|batches| batches.remove(&(session_id.clone(), cell_id)));
            let cell = cell_id.to_string();
            let _ = WorkerStore::durability()
                .transaction(
                    "cell_journal_forget",
                    &[
                        SqlStatement {
                            sql: CLEAR,
                            params: vec![&session_id, &cell],
                        },
                        SqlStatement {
                            sql: CLEAR_UPDATES,
                            params: vec![&session_id, &cell],
                        },
                    ],
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
                    sql: CREATE_BATCHES,
                    params: Vec::new(),
                },
                SqlStatement {
                    sql: SELECT,
                    params: vec![scope, scope],
                },
            ],
        )
        .await
        .map_err(|error| error.to_string())?;
    let mut cells: BTreeMap<(String, u64), Vec<CellJournalUpdate>> = BTreeMap::new();
    for row in rows.get(2).into_iter().flatten() {
        let Some(Some(body)) = row.first() else {
            continue;
        };
        for line in body.split('\n') {
            let Ok(update) = serde_json::from_str::<CellJournalUpdate>(line) else {
                continue;
            };
            cells
                .entry((update.session_id.clone(), update.cell_id))
                .or_default()
                .push(update);
        }
    }
    let mut sessions: BTreeMap<String, Vec<CellJournal>> = BTreeMap::new();
    for ((session_id, _), updates) in cells {
        if let Some(journal) = CellJournal::fold(updates) {
            sessions.entry(session_id).or_default().push(journal);
        }
    }
    Ok(sessions)
}
