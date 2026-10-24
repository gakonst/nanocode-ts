#![allow(clippy::missing_safety_doc)]

use std::cell::{Cell, RefCell};

use wasmi::{
    CompilationMode, Config, CustomFuelCosts, Engine, Error, Extern, ExternType, F32, F64, Func, FuncType, Instance,
    Memory, Module, ResumableCall, ResumableCallOutOfFuel, Store, StoreLimits, StoreLimitsBuilder,
    Val, ValType,
};

#[link(wasm_import_module = "host")]
unsafe extern "C" {
    fn call(instance: u32, import: u32, slots: *mut u64, params: u32, results: u32) -> u32;
}

struct Data {
    id: u32,
    limits: StoreLimits,
}

struct Slot {
    store: Store<Data>,
    instance: Instance,
    memory: Option<Memory>,
    pending: Option<(ResumableCallOutOfFuel, Vec<Val>)>,
}

thread_local! {
    static ENGINE: Engine = {
        let mut config = Config::default();
        config
            .consume_fuel(true)
            .fuel_cost(CustomFuelCosts {
                bytes_copied_per_fuel: 64,
                fuel_per_bytes_translated: 0,
                fuel_per_bytes_validated: 0,
            })
            .compilation_mode(CompilationMode::Lazy);
        Engine::new(&config)
    };
    static MODULES: RefCell<Vec<Option<Module>>> = const { RefCell::new(Vec::new()) };
    static INSTANCES: RefCell<Vec<Option<Slot>>> = const { RefCell::new(Vec::new()) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static ACTIVE: Cell<Option<(u32, u32, u32)>> = const { Cell::new(None) };
}

fn put<T>(list: &mut Vec<Option<T>>, value: T) -> u32 {
    if let Some(index) = list.iter().position(Option::is_none) {
        list[index] = Some(value);
        return index as u32;
    }
    list.push(Some(value));
    (list.len() - 1) as u32
}

fn output(text: &str) {
    OUT.with(|out| {
        let mut out = out.borrow_mut();
        out.clear();
        out.extend_from_slice(text.as_bytes());
    });
}

fn fail(error: impl std::fmt::Display) -> i32 {
    output(&error.to_string());
    -1
}

fn code(ty: &ValType) -> char {
    match ty {
        ValType::I32 => 'i',
        ValType::I64 => 'I',
        ValType::F32 => 'f',
        ValType::F64 => 'F',
        ValType::V128 => 'v',
        _ => 'r',
    }
}

fn signature(ty: &FuncType) -> String {
    let params: String = ty.params().iter().map(code).collect();
    let results: String = ty.results().iter().map(code).collect();
    format!("{params}\t{results}")
}

fn describe(ty: &ExternType) -> String {
    match ty {
        ExternType::Func(func) => format!("func\t{}", signature(func)),
        ExternType::Memory(_) => "memory\t\t".to_owned(),
        ExternType::Table(_) => "table\t\t".to_owned(),
        ExternType::Global(_) => "global\t\t".to_owned(),
    }
}

fn to_slot(value: &Val) -> Result<u64, Error> {
    Ok(match value {
        Val::I32(value) => *value as u32 as u64,
        Val::I64(value) => *value as u64,
        Val::F32(value) => value.to_bits() as u64,
        Val::F64(value) => value.to_bits(),
        _ => {
            return Err(Error::new(
                "only i32, i64, f32 and f64 values cross the host boundary",
            ));
        }
    })
}

fn from_slot(ty: &ValType, slot: u64) -> Result<Val, Error> {
    Ok(match ty {
        ValType::I32 => Val::I32(slot as u32 as i32),
        ValType::I64 => Val::I64(slot as i64),
        ValType::F32 => Val::F32(F32::from_bits(slot as u32)),
        ValType::F64 => Val::F64(F64::from_bits(slot)),
        _ => {
            return Err(Error::new(
                "only i32, i64, f32 and f64 values cross the host boundary",
            ));
        }
    })
}

fn zero(ty: &ValType) -> Val {
    from_slot(ty, 0).unwrap_or(Val::I32(0))
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(length: u32) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(length.max(1) as usize);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(pointer: *mut u8, length: u32) {
    drop(unsafe { Vec::from_raw_parts(pointer, 0, length.max(1) as usize) });
}

#[unsafe(no_mangle)]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|out| out.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn out_len() -> u32 {
    OUT.with(|out| out.borrow().len() as u32)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn load(pointer: *const u8, length: u32) -> i32 {
    let bytes = unsafe { std::slice::from_raw_parts(pointer, length as usize) };
    match ENGINE.with(|engine| Module::new(engine, bytes)) {
        Ok(module) => MODULES.with(|modules| put(&mut modules.borrow_mut(), module)) as i32,
        Err(error) => fail(error),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn module_drop(module: u32) {
    MODULES.with(|modules| {
        if let Some(slot) = modules.borrow_mut().get_mut(module as usize) {
            *slot = None;
        }
    });
}

fn module(id: u32) -> Option<Module> {
    MODULES.with(|modules| modules.borrow().get(id as usize).cloned().flatten())
}

#[unsafe(no_mangle)]
pub extern "C" fn imports(id: u32) -> i32 {
    let Some(module) = module(id) else {
        return fail("no such module");
    };
    let text: Vec<String> = module
        .imports()
        .map(|import| {
            format!(
                "{}\t{}\t{}",
                import.module(),
                import.name(),
                describe(import.ty())
            )
        })
        .collect();
    output(&text.join("\n"));
    text.len() as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn exports(id: u32) -> i32 {
    let Some(module) = module(id) else {
        return fail("no such module");
    };
    let text: Vec<String> = module
        .exports()
        .map(|export| format!("{}\t{}", export.name(), describe(export.ty())))
        .collect();
    output(&text.join("\n"));
    text.len() as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn instantiate(id: u32, memory_bytes: u32, fuel_lo: u32, fuel_hi: u32) -> i32 {
    let Some(module) = module(id) else {
        return fail("no such module");
    };
    let index = INSTANCES.with(|instances| {
        let list = instances.borrow();
        list.iter().position(Option::is_none).unwrap_or(list.len()) as u32
    });
    let limits = StoreLimitsBuilder::new()
        .memory_size(memory_bytes as usize)
        .instances(1)
        .build();
    let mut store = ENGINE.with(|engine| Store::new(engine, Data { id: index, limits }));
    store.limiter(|data| &mut data.limits);
    if store
        .set_fuel(((fuel_hi as u64) << 32) | fuel_lo as u64)
        .is_err()
    {
        return fail("fuel is not enabled");
    }
    let mut externs = Vec::new();
    for (position, import) in module.imports().enumerate() {
        let ExternType::Func(ty) = import.ty() else {
            return fail(format!(
                "{}.{} imports a {}, and only functions can be imported",
                import.module(),
                import.name(),
                describe(import.ty()).split('\t').next().unwrap_or("value")
            ));
        };
        let results: Vec<ValType> = ty.results().to_vec();
        let func = Func::new(&mut store, ty.clone(), move |caller, params, outputs| {
            let width = params.len().max(results.len()).max(1);
            let mut slots = vec![0u64; width];
            for (slot, value) in slots.iter_mut().zip(params) {
                *slot = to_slot(value)?;
            }
            let instance = caller.data().id;
            let memory = match caller.get_export("memory") {
                Some(Extern::Memory(memory)) => Some((
                    memory.data_ptr(&caller) as u32,
                    memory.data_size(&caller) as u32,
                )),
                _ => None,
            };
            let previous =
                ACTIVE.replace(memory.map(|(pointer, length)| (instance, pointer, length)));
            let status = unsafe {
                call(
                    instance,
                    position as u32,
                    slots.as_mut_ptr(),
                    params.len() as u32,
                    results.len() as u32,
                )
            };
            ACTIVE.set(previous);
            if status != 0 {
                return Err(Error::new("host"));
            }
            for ((output, ty), slot) in outputs.iter_mut().zip(&results).zip(&slots) {
                *output = from_slot(ty, *slot)?;
            }
            Ok(())
        });
        externs.push(Extern::Func(func));
    }
    match Instance::new(&mut store, &module, &externs) {
        Ok(instance) => {
            let memory = instance.get_memory(&store, "memory").or_else(|| {
                instance
                    .exports(&store)
                    .find_map(|export| export.into_memory())
            });
            INSTANCES.with(|instances| {
                put(
                    &mut instances.borrow_mut(),
                    Slot {
                        store,
                        instance,
                        memory,
                        pending: None,
                    },
                )
            }) as i32
        }
        Err(error) if error.as_trap_code().is_some() => {
            output(&error.to_string());
            -2
        }
        Err(error) => fail(error),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn instance_drop(id: u32) {
    INSTANCES.with(|instances| {
        if let Some(slot) = instances.borrow_mut().get_mut(id as usize) {
            *slot = None;
        }
    });
}

fn with_slot<R>(id: u32, work: impl FnOnce(&mut Slot) -> R) -> Option<R> {
    INSTANCES.with(|instances| {
        instances
            .borrow_mut()
            .get_mut(id as usize)
            .and_then(Option::as_mut)
            .map(work)
    })
}

fn settle(
    slot: &mut Slot,
    result: Result<ResumableCall, Error>,
    mut outputs: Vec<Val>,
    slots: *mut u64,
) -> i32 {
    match result {
        Ok(ResumableCall::Finished) => {
            for (index, value) in outputs.iter().enumerate() {
                match to_slot(value) {
                    Ok(bits) => unsafe { *slots.add(index) = bits },
                    Err(error) => return fail(error),
                }
            }
            0
        }
        Ok(ResumableCall::OutOfFuel(call)) => {
            outputs
                .iter_mut()
                .for_each(|value| *value = zero(&value.ty()));
            slot.pending = Some((call, outputs));
            2
        }
        Ok(ResumableCall::HostTrap(_)) => 3,
        Err(error) => {
            output(&error.to_string());
            if error.as_trap_code().is_some() { 1 } else { 4 }
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn invoke(
    id: u32,
    name: *const u8,
    name_length: u32,
    slots: *mut u64,
    count: u32,
    fuel_lo: u32,
    fuel_hi: u32,
) -> i32 {
    let name = unsafe { std::slice::from_raw_parts(name, name_length as usize) };
    let Ok(name) = std::str::from_utf8(name) else {
        return fail("export names are UTF-8");
    };
    with_slot(id, |slot| {
        slot.pending = None;
        let Some(func) = slot.instance.get_func(&slot.store, name) else {
            return fail(format!("no exported function named {name}"));
        };
        let ty = func.ty(&slot.store);
        if ty.params().len() != count as usize {
            return fail(format!(
                "{name} takes {} arguments, not {count}",
                ty.params().len()
            ));
        }
        let mut inputs = Vec::new();
        for (index, param) in ty.params().iter().enumerate() {
            match from_slot(param, unsafe { *slots.add(index) }) {
                Ok(value) => inputs.push(value),
                Err(error) => return fail(error),
            }
        }
        let mut outputs: Vec<Val> = ty.results().iter().map(zero).collect();
        if slot
            .store
            .set_fuel(((fuel_hi as u64) << 32) | fuel_lo as u64)
            .is_err()
        {
            return fail("fuel is not enabled");
        }
        let result = func.call_resumable(&mut slot.store, &inputs, &mut outputs);
        settle(slot, result, outputs, slots)
    })
    .unwrap_or_else(|| fail("no such instance"))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn resume(id: u32, slots: *mut u64, fuel_lo: u32, fuel_hi: u32) -> i32 {
    with_slot(id, |slot| {
        let Some((call, mut outputs)) = slot.pending.take() else {
            return fail("no call is waiting for fuel");
        };
        if slot
            .store
            .set_fuel(((fuel_hi as u64) << 32) | fuel_lo as u64)
            .is_err()
        {
            return fail("fuel is not enabled");
        }
        let result = call.resume(&mut slot.store, &mut outputs);
        settle(slot, result, outputs, slots)
    })
    .unwrap_or_else(|| fail("no such instance"))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn results(id: u32, name: *const u8, name_length: u32) -> i32 {
    let name = unsafe { std::slice::from_raw_parts(name, name_length as usize) };
    let Ok(name) = std::str::from_utf8(name) else {
        return fail("export names are UTF-8");
    };
    with_slot(id, |slot| match slot.instance.get_func(&slot.store, name) {
        Some(func) => {
            output(&signature(&func.ty(&slot.store)));
            0
        }
        None => fail(format!("no exported function named {name}")),
    })
    .unwrap_or_else(|| fail("no such instance"))
}

#[unsafe(no_mangle)]
pub extern "C" fn memory_ptr(id: u32) -> u32 {
    if let Some((instance, pointer, _)) = ACTIVE.get()
        && instance == id
    {
        return pointer;
    }
    with_slot(id, |slot| {
        slot.memory
            .map_or(0, |memory| memory.data_ptr(&slot.store) as u32)
    })
    .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn memory_len(id: u32) -> u32 {
    if let Some((instance, _, length)) = ACTIVE.get()
        && instance == id
    {
        return length;
    }
    with_slot(id, |slot| {
        slot.memory
            .map_or(0, |memory| memory.data_size(&slot.store) as u32)
    })
    .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn memory_grow(id: u32, pages: u32) -> i32 {
    with_slot(id, |slot| match slot.memory {
        Some(memory) => memory
            .grow(&mut slot.store, pages as u64)
            .map_or(-1, |old| old as i32),
        None => -1,
    })
    .unwrap_or(-1)
}
