use std::{
    cell::{Cell, RefCell},
    io,
    rc::Rc,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use nanocode_platform::{Host, LocalFuture};
use nanocode_python::{
    Child, Ended, Exited, Files, Kind, Limit, Limits, Python, Remove, Run, Stat, Why, Write,
};

#[global_allocator]
static ALLOCATOR: nanocode_python::Metered<std::alloc::System> =
    nanocode_python::Metered(std::alloc::System);

#[link(wasm_import_module = "python")]
unsafe extern "C" {
    fn host_fs(
        op: u32,
        path: *const u8,
        path_len: usize,
        data: *const u8,
        data_len: usize,
        arg: u64,
    ) -> i64;
    fn host_now() -> f64;
    fn host_panic(text: *const u8, len: usize);
    fn host_random(bytes: *mut u8, len: usize);
    fn host_spawn(child: *const u8, len: usize) -> i64;
    fn host_stopped() -> u32;
    fn host_time() -> f64;
}

const STAT: u32 = 0;
const READ: u32 = 1;
const WRITE: u32 = 2;
const LIST: u32 = 3;
const MKDIR: u32 = 4;
const REMOVE: u32 = 5;
const RENAME: u32 = 6;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static INSTALLED: Cell<bool> = const { Cell::new(false) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static PYTHON: RefCell<Option<Python>> = const { RefCell::new(None) };
    static REPLY: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

struct Page;

impl Host for Page {
    fn spawn_local(&self, _: LocalFuture<'static, ()>) {
        panic!("python.wasm runs no tasks")
    }

    fn sleep(&self, _: Duration) -> LocalFuture<'static, ()> {
        panic!("python.wasm does not sleep")
    }

    fn monotonic_time(&self) -> Duration {
        Duration::from_secs_f64(unsafe { host_now() } / 1000.0)
    }

    fn system_time(&self) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs_f64(unsafe { host_time() } / 1000.0)
    }

    fn fill_random(&self, bytes: &mut [u8]) -> io::Result<()> {
        unsafe { host_random(bytes.as_mut_ptr(), bytes.len()) };
        Ok(())
    }
}

fn failure(code: i64) -> io::Error {
    let kind = match code {
        2 => io::ErrorKind::NotFound,
        4 => io::ErrorKind::Interrupted,
        11 => io::ErrorKind::WouldBlock,
        13 => io::ErrorKind::PermissionDenied,
        17 => io::ErrorKind::AlreadyExists,
        20 => io::ErrorKind::NotADirectory,
        21 => io::ErrorKind::IsADirectory,
        22 => io::ErrorKind::InvalidInput,
        27 => io::ErrorKind::FileTooLarge,
        30 => io::ErrorKind::ReadOnlyFilesystem,
        39 => io::ErrorKind::DirectoryNotEmpty,
        95 => io::ErrorKind::Unsupported,
        _ => return io::Error::other(format!("the host failed with errno {code}")),
    };
    kind.into()
}

fn call(op: u32, path: &[u8], data: &[u8], arg: u64) -> io::Result<Vec<u8>> {
    let got = unsafe {
        host_fs(
            op,
            path.as_ptr(),
            path.len(),
            data.as_ptr(),
            data.len(),
            arg,
        )
    };
    let Ok(len) = usize::try_from(got) else {
        return Err(failure(-got));
    };
    Ok(REPLY.with_borrow_mut(|reply| {
        let mut taken = std::mem::take(reply);
        taken.truncate(len);
        taken
    }))
}

struct Shell {
    spawns: bool,
}

impl Files for Shell {
    fn stat(&self, path: &[u8]) -> io::Result<Stat> {
        let reply = call(STAT, path, &[], 0)?;
        let mut reader = Reader(&reply);
        let kind = match reader.u32() {
            1 => Kind::Dir,
            2 => Kind::Symlink,
            _ => Kind::File,
        };
        let mode = reader.u32();
        let size = reader.u64();
        let mtime_ns = reader.u64().cast_signed();
        Ok(Stat {
            kind,
            size,
            mode,
            mtime_ns,
        })
    }

    fn read(&self, path: &[u8], limit: u64) -> io::Result<Vec<u8>> {
        let data = call(READ, path, &[], limit)?;
        if data.len() as u64 > limit {
            return Err(io::ErrorKind::FileTooLarge.into());
        }
        Ok(data)
    }

    fn write(&self, path: &[u8], data: &[u8], how: Write) -> io::Result<()> {
        let how = match how {
            Write::Replace => 0,
            Write::Append => 1,
            Write::New => 2,
        };
        call(WRITE, path, data, how).map(drop)
    }

    fn list(&self, path: &[u8]) -> io::Result<Vec<Vec<u8>>> {
        let names = call(LIST, path, &[], 0)?;
        Ok(names
            .split(|&byte| byte == 0)
            .filter(|name| !name.is_empty())
            .map(<[u8]>::to_vec)
            .collect())
    }

    fn mkdir(&self, path: &[u8], mode: u32) -> io::Result<()> {
        call(MKDIR, path, &[], u64::from(mode)).map(drop)
    }

    fn remove(&self, path: &[u8], what: Remove) -> io::Result<()> {
        let what = match what {
            Remove::File => 0,
            Remove::Dir => 1,
        };
        call(REMOVE, path, &[], what).map(drop)
    }

    fn rename(&self, from: &[u8], to: &[u8]) -> io::Result<()> {
        call(RENAME, from, to, 0).map(drop)
    }

    fn spawns(&self) -> bool {
        self.spawns
    }

    fn spawn(&self, child: Child) -> io::Result<Exited> {
        let mut out = Vec::new();
        let count = |len: usize| u32::try_from(len).unwrap_or(u32::MAX).to_le_bytes();
        out.extend_from_slice(&count(child.argv.len()));
        for word in &child.argv {
            put(&mut out, word);
        }
        out.extend_from_slice(&count(child.env.len()));
        for (name, value) in &child.env {
            put(&mut out, name);
            put(&mut out, value);
        }
        put(&mut out, &child.cwd);
        put(&mut out, &child.stdin);
        out.extend_from_slice(&u32::from(child.merged).to_le_bytes());
        let got = unsafe { host_spawn(out.as_ptr(), out.len()) };
        let Ok(len) = usize::try_from(got) else {
            return Err(failure(-got));
        };
        let reply = REPLY.with_borrow_mut(|reply| {
            let mut taken = std::mem::take(reply);
            taken.truncate(len);
            taken
        });
        let mut reader = Reader(&reply);
        let status = reader.u32().cast_signed();
        let stdout = reader.bytes();
        let stderr = reader.bytes();
        Ok(Exited {
            status,
            stdout,
            stderr,
        })
    }
}

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn take(&mut self, len: usize) -> &[u8] {
        let (head, rest) = self.0.split_at(len.min(self.0.len()));
        self.0 = rest;
        head
    }

    fn u32(&mut self) -> u32 {
        let mut bytes = [0; 4];
        bytes.copy_from_slice(self.take(4));
        u32::from_le_bytes(bytes)
    }

    fn u64(&mut self) -> u64 {
        let mut bytes = [0; 8];
        bytes.copy_from_slice(self.take(8));
        u64::from_le_bytes(bytes)
    }

    fn bytes(&mut self) -> Vec<u8> {
        let len = self.u32() as usize;
        self.take(len).to_vec()
    }
}

fn put(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_le_bytes());
    out.extend_from_slice(bytes);
}

fn request(input: &[u8]) -> (Run, Shell) {
    let mut reader = Reader(input);
    let argv = (0..reader.u32())
        .map(|_| String::from_utf8_lossy(&reader.bytes()).into_owned())
        .collect();
    let cwd = reader.bytes();
    let env = (0..reader.u32())
        .map(|_| (reader.bytes(), reader.bytes()))
        .collect();
    let stdin = reader.bytes();
    let limits = Limits {
        output: reader.u64(),
        file: reader.u64(),
        steps: reader.u64(),
        time: Duration::from_millis(reader.u64()),
        depth: usize::try_from(reader.u64()).unwrap_or(usize::MAX),
        memory: Some(reader.u64()),
        sleep: Duration::MAX,
    };
    let shell = Shell {
        spawns: reader.u32() != 0,
    };
    let run = Run {
        argv,
        stdin,
        cwd,
        env,
        limits,
        stop: Arc::new(|| unsafe { host_stopped() } != 0),
    };
    (run, shell)
}

fn respond(ended: &Ended, stdout: &[u8], stderr: &[u8], steps: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(stdout.len() + stderr.len() + 64);
    let (tag, value) = match ended {
        Ended::Exited(code) => (0, code.cast_unsigned()),
        Ended::Needs(_) => (1, 0),
        Ended::Refused(limit) => (
            2,
            match limit {
                Limit::Output => 0,
                Limit::Sleep => 1,
                Limit::Steps => 2,
                Limit::Time => 3,
                Limit::Memory => 4,
            },
        ),
        Ended::Cancelled => (3, 0),
    };
    out.extend_from_slice(&u32::to_le_bytes(tag));
    out.extend_from_slice(&u32::to_le_bytes(value));
    put(&mut out, stdout);
    put(&mut out, stderr);
    out.extend_from_slice(&steps.to_le_bytes());
    let missing = match ended {
        Ended::Needs(missing) => missing.as_slice(),
        _ => &[],
    };
    out.extend_from_slice(
        &u32::try_from(missing.len())
            .unwrap_or(u32::MAX)
            .to_le_bytes(),
    );
    for missing in missing {
        put(&mut out, missing.module.as_bytes());
        out.extend_from_slice(&u32::to_le_bytes(match missing.why {
            Why::Package => 0,
            Why::Machine => 1,
        }));
        put(&mut out, missing.to_string().as_bytes());
    }
    out
}

#[unsafe(no_mangle)]
pub extern "C" fn python_input(len: usize) -> *mut u8 {
    INPUT.with_borrow_mut(|input| {
        input.clear();
        input.resize(len, 0);
        input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn python_reply(len: usize) -> *mut u8 {
    REPLY.with_borrow_mut(|reply| {
        reply.clear();
        reply.resize(len, 0);
        reply.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn python_output() -> *const u8 {
    OUTPUT.with_borrow(Vec::as_ptr)
}

#[unsafe(no_mangle)]
pub extern "C" fn python_run() -> usize {
    if !INSTALLED.replace(true) {
        std::panic::set_hook(Box::new(|info| {
            let text = info.to_string();
            unsafe { host_panic(text.as_ptr(), text.len()) };
        }));
        nanocode_platform::install(Rc::new(Page)).expect("python.wasm installs its host once");
    }
    let (run, shell) = INPUT.with_borrow_mut(|input| request(&std::mem::take(input)));
    let out = PYTHON.with_borrow_mut(|kept| {
        let python = match kept {
            Some(python) => python,
            None => match Python::new() {
                Ok(python) => kept.insert(python),
                Err(error) => {
                    let said = format!("python3: cannot start: {error}\n");
                    return respond(&Ended::Exited(1), &[], said.as_bytes(), 0);
                }
            },
        };
        let ran = python.run(run, Rc::new(shell));
        respond(&ran.ended, &ran.stdout, &ran.stderr, ran.steps)
    });
    let len = out.len();
    OUTPUT.set(out);
    len
}
