use nanocode::durability::{
    BlobKey, BlobStore, Sql, SqlRow, SqlStatement, StoreError, StoreFuture,
};
use serde::Serialize;
use serde_json::{Value, json};

use super::bridge::{call_bytes_with, call_optional_bytes, call_with_body};

const NULL_CELL: u32 = u32::MAX;

pub struct WorkerStore(&'static str);

impl WorkerStore {
    pub const fn durability() -> Self {
        Self("store")
    }

    pub const fn log() -> Self {
        Self("log")
    }
}

#[derive(Serialize)]
struct Transaction<'a> {
    op: &'static str,
    operation: &'static str,
    statements: Interned<'a>,
}

thread_local! {
    static SENT: std::cell::RefCell<std::collections::HashMap<usize, u32>> = std::cell::RefCell::default();
}

struct Interned<'a>(&'a [SqlStatement<'a>]);

impl Serialize for Interned<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut statements = serializer.serialize_seq(Some(self.0.len()))?;
        for statement in self.0 {
            statements.serialize_element(&Statement(statement))?;
        }
        statements.end()
    }
}

struct Statement<'a>(&'a SqlStatement<'a>);

impl Serialize for Statement<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let statement = self.0;
        let mut sequence = serializer.serialize_seq(Some(statement.params.len() + 1))?;
        let known = SENT.with_borrow_mut(|sent| {
            let next = u32::try_from(sent.len()).unwrap_or(u32::MAX);
            match sent.entry(statement.sql.as_ptr() as usize) {
                std::collections::hash_map::Entry::Occupied(entry) => Ok(*entry.get()),
                std::collections::hash_map::Entry::Vacant(entry) => Err(*entry.insert(next)),
            }
        });
        match known {
            Ok(id) => sequence.serialize_element(&id)?,
            Err(id) => sequence.serialize_element(&(id, statement.sql))?,
        }
        for param in &statement.params {
            sequence.serialize_element(param)?;
        }
        sequence.end()
    }
}

struct Rows<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl Rows<'_> {
    fn take(&mut self, length: usize) -> Result<&[u8], String> {
        let end = self
            .offset
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or("SQL reply ended early")?;
        let taken = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(taken)
    }

    fn word(&mut self) -> Result<u32, String> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn count(&mut self) -> Result<(usize, usize), String> {
        let count = self.word()? as usize;
        Ok((count, count.min((self.bytes.len() - self.offset) / 4)))
    }

    fn cell(&mut self) -> Result<Option<String>, String> {
        let length = self.word()?;
        if length == NULL_CELL {
            return Ok(None);
        }
        let text =
            std::str::from_utf8(self.take(length as usize)?).map_err(|error| error.to_string())?;
        Ok(Some(text.to_owned()))
    }

    fn decode(mut self) -> Result<Vec<Vec<SqlRow>>, String> {
        let (statements, capacity) = self.count()?;
        let mut decoded = Vec::with_capacity(capacity);
        for _ in 0..statements {
            let (rows, capacity) = self.count()?;
            let mut statement = Vec::with_capacity(capacity);
            for _ in 0..rows {
                let (cells, capacity) = self.count()?;
                let mut row = Vec::with_capacity(capacity);
                for _ in 0..cells {
                    row.push(self.cell()?);
                }
                statement.push(row);
            }
            decoded.push(statement);
        }
        if self.offset != self.bytes.len() {
            return Err("SQL reply has trailing bytes".into());
        }
        Ok(decoded)
    }
}

impl Sql for WorkerStore {
    fn transaction<'a>(
        &'a self,
        operation: &'static str,
        statements: &'a [SqlStatement<'a>],
    ) -> StoreFuture<'a, Result<Vec<Vec<SqlRow>>, StoreError>> {
        Box::pin(async move {
            let bytes = call_bytes_with(&Transaction {
                op: self.0,
                operation,
                statements: Interned(statements),
            })
            .await
            .map_err(|error| StoreError::Backend(error.to_string()))?;
            Rows {
                bytes: &bytes,
                offset: 0,
            }
            .decode()
            .map_err(StoreError::Backend)
        })
    }
}

pub struct WorkerBlobs;

fn backend(error: Value) -> StoreError {
    StoreError::Backend(error.to_string())
}

impl BlobStore for WorkerBlobs {
    fn put<'a>(
        &'a self,
        key: &'a BlobKey,
        bytes: &'a [u8],
    ) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            call_with_body(json!({"op": "blob_put", "key": key.as_str()}), bytes)
                .await
                .map(drop)
                .map_err(backend)
        })
    }

    fn get<'a>(&'a self, key: &'a BlobKey) -> StoreFuture<'a, Result<Option<Vec<u8>>, StoreError>> {
        Box::pin(async move {
            call_optional_bytes(json!({"op": "blob_get", "key": key.as_str()}))
                .await
                .map_err(backend)
        })
    }
}
