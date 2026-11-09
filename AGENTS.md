# Agent Guidelines

## Development

These principles come from nanocodexyz/nanocode's `AGENTS.md` and apply to every change here.

- Keep code simple and changes small. Match the surrounding code and preserve unrelated work.
- No code comments, doc comments (TSDoc, `@module` blocks, `///`, `//!`) or section dividers, README edits, tests, type-test fixtures or test-only dependencies. Only comments that a tool reads stay, such as `@ts-expect-error`.
- No magic constants or arbitrary caps: a limit comes from a protocol, a measurement or host policy. Surface invalid states; never hide them with silent truncation, clamping or fallbacks.
- Make invalid states unrepresentable: model a lifecycle as one discriminated union whose variants carry only what that phase has.
- Preserve public APIs.
- Inference, subagents and durability live in the brain; Code Mode runs on the user's machine. Never silently replay dispatched work: report uncertain outcomes.
- Validate with focused checks (`npm run check:types`, `npm run build`) and back performance changes with reproducible before/after measurements, keeping cold builds, incremental builds and runtime performance separate.
- Check behavior with harnesses in ignored `output/` and the measurement scripts in `scripts/` and `bench/`, run against local mocks or the demos, with builds compared by interleaved runs. Keep every artifact in `output/`; never commit them, credentials or personal data.
- Work on master in the main checkout, commit only your own changes and push each one; no pull requests. There is no CI: build, release and deploy by hand. Use subagents only when asked.
- This file holds principles only and rarely changes. DECISIONS.md is the growing log: add what each change establishes and why, with the commands, dates and measurements behind it.

## Project Principles

- nanocode-ts compiles the nanocode Rust SDK (`../nanocodex`, pinned in `sdk-revision.json`) into one WebAssembly module, and hosts it from TypeScript in any runtime that instantiates WebAssembly: Cloudflare Workers, Node, Deno, and browsers. A host repository writes only TypeScript and builds no Rust.
- Generic agent, durability, turn, and event logic belongs in the SDK. Host-agnostic bridge glue belongs in the root modules, each platform's runtime and wiring in its adapter folder, and an application's own tools, models, authorization policy, pages, and commands in the host repository.
- Send models only the SDK's native prompts and tool text. nanocode-ts defines no system or developer instructions, workspace instructions, or tool description overrides. `instructions` stays an option for hosts.
- Host-agnostic modules use only the standard web platform types: no Node APIs, no `@cloudflare/workers-types`, no Durable Object types. Hosts supply platform capabilities through the contracts in `Contracts.ts` or take an adapter's.
- Every runtime is its own package subpath, and `package.json` marks only `*.css` as side effects. A page that imports a browser transport bundles no Worker, Node, or WebAssembly code.
- Limits come from host policy passed in, never from constants in this package.
- The Rust side is single-threaded and keeps its state in `thread_local` cells, with no `Mutex` or `RwLock`.
- TypeScript uses only erasable syntax (`erasableSyntaxOnly`, `verbatimModuleSyntax`), so Node 22.18 or newer runs the sources directly with type stripping from a checkout or a `file:` link.

## TypeScript Conventions

- Treat `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` as design constraints. Include `| undefined` when an optional property can explicitly receive `undefined`, and narrow indexed reads before use.
- Use `readonly T[]` for array types. Preserve mutable arrays only when mutation is part of the contract.
- Use `type` for project-owned shapes. Use `interface` only when declaration merging or an external ambient contract requires it.
- Include `.ts` extensions on relative imports and exports. Node's type stripping resolves only real file names, and `rewriteRelativeImportExtensions` rewrites them to `.js` in `dist/`.
- Author every source file and script in TypeScript. Node runs TypeScript natively (`node script.ts`), so scripts need no build step. JavaScript is limited to code that runs inside QuickJS, such as `src/wasm/prelude.js`, and to the `.mjs` build and release scripts in `scripts/`.
- Import module-shaped internal files as namespaces (`import * as Store from './Store.ts'`) and access members through the module name. Named imports are fine for types, leaf helpers, command handlers, and third-party APIs that are not module namespaces.
- Import Node built-ins as namespaces unless the neighboring code or API is clearer with a named import.
- Re-export public module files as namespaces (`export * as Store from './Store.ts'`). Avoid flattening sibling-module symbols into a barrel.
- Use static imports. Reserve dynamic imports for a real runtime or bundle boundary, such as a lazily loaded wallet or Pyodide, not dependency-cycle workarounds.
- Use `import type` and `export type` where an import or export is type-only.
- Use functions and plain data for normal APIs. Classes are limited to errors and framework-required entrypoints such as Durable Objects.
- Keep error classes in the module that throws them, ordered alphabetically with its public exports. Set custom error `name` values to the namespaced form, such as `Config.InvalidError`.
- Use unions or `as const` objects instead of enums.
- Prefer `camelCase` constants. Preserve uppercase names only when they mirror an external protocol or established neighboring code.
- Use `const` generic parameters when callers should retain literal or tuple types.
- Default optional option bags in the signature (`options: fn.Options = {}`), not with `options?: fn.Options` and downstream fallback logic.
- Name typed option bags `options`. Use a domain noun only when the value is not an options bag.
- Functions take at most two positional parameters: an optional leading receiver or inspected value, then one options object. The receiver is an instance such as `client`, `runtime`, or `fs`, or the value the function inspects or converts. Every other input goes in the options object.

  ```ts
  Hand.connect(module, { url, workspace }) // not connect(module, url, workspace)
  ```

  Signatures that a library, framework, or wire contract dictates, such as host imports of the WebAssembly module, Durable Object methods, and callbacks, are exempt.

- Put a function's parameter, return, and error types in a matching `declare namespace` (`resolve.Options`, `resolve.ReturnType`, `resolve.ErrorType`). Keep a sibling exported type only when several functions share the domain type.
- Avoid inline object types on local variables. When an explicit local object type improves clarity, name it directly above the use.
- Do not extract a named type until it is reused or makes a difficult shape materially easier to read.
- Keep shared domain types beside the module that owns the concept.
- Group a module's Zod schemas in a `schema` namespace, and derive their types beside them (`schema.Document`). Export the namespace only when another module validates against the same shape.
- Let declared return types constrain intermediate expressions. Avoid redundant local annotations.
- Return values directly unless a binding is reused or gives a complex expression a useful name.
- Prefer immediately invoked function expressions (IIFEs) with explicit branches and early returns over nested or complex ternary expressions. Keep simple two-way ternaries when both branches are easy to scan. This applies to executable code, not TypeScript conditional types.
- For a fallible local derivation, prefer an IIFE expression over a mutable variable assigned across `try` and `catch` blocks.
- Never destructure parameters in function definitions, including arrow functions, callbacks, and methods. Accept a named parameter and destructure inside the body when reading several properties. When normalizing one field, read `options.field` directly instead of creating a second name.
- Declare component props as `Component.Props` inside the component's matching namespace, including nested components such as `Chat.Composer.Props`. Do not use inline props types or standalone component props aliases.
- Prefer short names whose meaning is clear from local context, such as `options`, `client`, `entry`, and `fn`.
- Keep wire formats, ordered tuples, protocol fields, and other order-sensitive shapes explicit. Do not alphabetize data whose order has meaning.
- Avoid new `any`. Use a precise boundary type, validation, narrowing, or the smallest justified assertion.
- Separate distinct contexts and logical steps with one blank line in every maintained module, including source, adapters, scripts, and benchmarks. Group setup, guard clauses, derivation, mutation or emission, and final returns so each step is easy to scan.
- Keep a lookup with its immediate guard, related local declarations, and consecutive assertions together. Separate independent branches, loops, local helper functions, and the work following a completed control-flow block. Avoid both dense uninterrupted logic and a blank line after every statement. Preserve spacing inside generated source strings and other whitespace-sensitive text.

## Rust Conventions

The SDK host glue is written in Rust and reaches JavaScript through a `wasm32-unknown-unknown` module with a hand-written ABI. TypeScript conventions still apply wherever they have a Rust equivalent.

### Crates and Modules

- Keep the WebAssembly crate a thin adapter around the SDK. It copies input into linear memory, calls the SDK, and returns output and errors. Agent logic in the adapter belongs in the SDK.
- Keep items `pub(crate)` unless another crate has a real contract with them.
- Generate shared data tables from their authoritative sources with a repository script, such as the model catalog that `scripts/build.mjs` writes from `AgentRuntime.modelCatalog()`, and keep them in ignored build output.
- Add no dependency without a size measurement of the WebAssembly module. Hand-written code is preferred over a dependency that grows it.

### Language

- Use edition 2024 and pin the toolchain in `rust-toolchain.toml`. Declare `rust-version` in `Cargo.toml`.
- Suppress a lint locally with `#[expect(lint, reason = "...")]`, never `#[allow]`. An unneeded expectation then fails the build.
- Use `unsafe` only for linear-memory exports and imports.
- Use plain data, functions, and enums. Traits exist for real polymorphism, not for namespacing.
- Order `use` declarations, struct fields, and enum variants alphabetically unless order is observable, such as derived `Ord`, serialization, and `repr(C)` layout.
- Mark `#[inline(always)]` only with a measured reason and `#[expect(clippy::inline_always, reason = "...")]`. Put error construction behind `#[cold]` functions.

### Memory and Data Layout

- Link mutable records by index, not by reference or pointer.
- Keep hot types small. Box rare large variants, and assert sizes of hot types with `const _: () = assert!(size_of::<Value>() == 16);`.
- Move values with `std::mem::take` instead of cloning.
- Use an insertion-ordered structure wherever iteration order can reach output. Never iterate a hash map to produce output.

### Strings and Numbers

- Store UTF-8 offsets internally. Convert to UTF-16 only at the JavaScript boundary.
- Avoid allocating string transforms in hot paths. Compare with `eq_ignore_ascii_case`, and return `Cow<str>` from conditional rewrites.
- Build output in one preallocated `String`. Do not allocate a string just to compare it. Never format an `f64` with `{}` for output that JavaScript reads.

### WebAssembly Boundary

- Export a small C ABI without `wasm-bindgen`. The TypeScript wrapper copies input in and decodes one result.
- Cross the boundary per operation, never per item. Pass bytes through linear memory, not base64 or JSON arrays.
- Return errors as typed values with a code and a message. The TypeScript wrapper throws namespaced error classes. Error messages are public contract.
- Build with `panic = "abort"` for WebAssembly. A panic is a defect.

## Alphabetical Ordering

- Alphabetize imports, named import/export specifiers, public exports, type properties, object properties, union members, unordered lists, configuration maps, scripts, and dependencies. Use case-insensitive lexical order consistently.
- Keep function overloads and their namespace together. Order local declarations alphabetically within dependency-compatible groups. Do not introduce use-before-initialization or reorder execution.
- Preserve order with observable semantics: SQL statements and columns, event sequences, shell builtins that shadow each other, CSS declarations, tuples, and package file inclusions followed by exclusions. The order-sensitive and durable values that are not obvious from the code are listed under Durable Values in DECISIONS.md.
- Do not alphabetize prose sections or sequential implementation phases mechanically.

## Module and Instance Conventions

- Organize each module file as one conceptual namespace containing its public types, constants, functions, and errors. Consumers read calls as `Module.operation(...)`.
- Prefer stateless module functions for pure behavior. Do not create an instance when inputs fully describe the operation.
- When behavior needs dependencies or lifecycle state, expose a factory such as `Module.create(options)` that returns a plain object of operations and data.
- Construct instances explicitly at the application boundary and pass them down. Do not hide construction in imports or module-scope singletons.
- Scope an instance to the lifecycle that owns its state, such as one session, one Worker isolate, or one Durable Object. Do not share mutable state more broadly than required.
- Inject environment-specific capabilities through factory options or narrow structural types. Keep filesystem, network, storage, clock, and platform bindings out of domain modules.
- Type dependencies by the smallest capability the module consumes, not by the concrete SDK client. This keeps adapters interchangeable without wrapper classes.
- Let factory operations close over shared dependencies and state. Do not return methods that depend on `this` or require binding.
- Name the returned public shape after its role (`Runtime`, `Client`, `Session`, `Store`) when that role is meaningful. Use `create.ReturnType` for a factory-specific shape that has no independent domain name.
- Keep one authoritative instance value. Derive related helpers and views from that instance instead of duplicating configuration or state.
- Keep mutable caches and registries private to the instance. Expose explicit operations, and provide reset or disposal only when the lifecycle requires it.
- Avoid side-effect registration. `sideEffects` lists only `*.css`, so an import used only to install global behavior can disappear from a bundle.
- Keep default implementations directly reachable from the factory or resolver that selects them so bundlers can tree-shake unused paths.
- Pass an existing receiver first to stateless operations (`Bash.exec(bash, options)`). Create a factory only when several operations genuinely share dependencies, state, or lifecycle.
- Keep transport-independent planning, parsing, and normalization pure. Put filesystem, network, and Worker behavior in thin adapters around that core.
- Keep internal helpers under `internal/` and export them only when another module has a real contract with them.
- Add new public modules through the owning entrypoint as namespace exports. Keep the public surface lean and derive values that the library already knows.
- A framework-mandated class, such as a Durable Object, delegates reusable logic to module functions so the class remains a small lifecycle adapter.

## Type Inference Conventions

- Preserve literal inputs through public helpers when those literals affect the output type.
- Keep generic types flowing from inputs through callbacks and return values. Do not erase them to `any` at an internal seam.
- Prevent public callbacks, options, and return values from leaking `any`.
- Revisit inference after changing an API. Prefer a narrower useful contract over a broad type that merely compiles.

## Abstraction Conventions

- Start with concrete code and extract only after repeated uses reveal a stable shared contract.
- Prefer small local duplication over an abstraction that adds flags, modes, or call-site-specific branches.
- Wait for at least three concrete uses before introducing a general abstraction unless a hard boundary already exists.
- Optimize for code that is easy to change, not maximum DRYness.
- Keep authoritative state, configuration, schemas, and constants in one place, and derive dependent values.
- Avoid wrappers that only rename another function or mirror an SDK without narrowing capabilities or adding a domain contract.

## Prose Conventions

Applies to this file, interface copy, and commit messages.

- Write about the code, not about the person using it. Avoid second person outside interface copy.
- Describe behavior in technical terms rather than by the experience it produces. Prefer `answers before acquisition finishes` over `keeps the editor feeling fast`.
- Write formally, concisely, and technically. Use precise verbs such as "returns", "emits", "rejects", "serves", "throws", and "requests", not conversational ones such as "hands", "gets", "gives", "sees", "knows", "says", or "tells".
- State an invariant or a reason the code cannot show on its own. Leave out justification the code already makes plain.
- Write close to ASD-STE100 Simplified Technical English. Apply its writing rules below, but not its full dictionary.
- Use the short, common word: "use", "start", "before", "about", "make sure", not "utilize", "commence", "prior to", "approximately", "ensure". Technical names from the codebase and its protocols are always valid.
- Use one word for one thing, and give each word one meaning and one part of speech. Do not use a synonym for variety.
- Keep an instruction to 20 words or fewer, and a descriptive sentence to 25 words or fewer. Give one instruction in each sentence, unless the actions occur at the same time.
- Keep each paragraph to one topic and six sentences or fewer. Use a vertical list for sequential steps or several conditions.
- Put a condition before the instruction it controls: "If the release is missing, build the module."
- Use the active voice in instructions. Use the passive voice in descriptions only when the agent is unknown or not important.
- Use the imperative, simple present, simple past, and simple future. Do not use a progressive (`-ing`) or perfect form as the main verb. An `-ing` word in a technical name, such as "signing key", is valid.
- Do not stack more than three nouns, except in a technical name. Break a longer cluster with a preposition.
- Do not leave out "the", "a", or "this" to make a sentence shorter.
- Vary sentence construction. One shape repeated across a file reads as a writing style rather than as information.
- Use a diagram, not prose, to show a flow or how components connect, and keep it to about 12 nodes. Use a table, not a paragraph, to compare options or map inputs to outputs.
- Do not use semicolons or em dashes in prose. Split the sentence, or use a comma, colon, or parenthesis. Semicolons remain valid inside code and CSS.

## Benchmark Conventions

- Keep benchmarks and evals in `bench/` and measurement scripts in `scripts/`.
- Benchmark complete public workflows, such as a cold session open or a full turn, not isolated functions.
- Write generated reports under ignored `output/` (`bench/` writes to `output/bench/`). A measurement recorded here names one run, commit, machine, and sample count, and keeps every lane including losses.
- Record commit, tool versions, hardware, warmup, sample count, median, and p95. Confirm timing regressions with repeated samples instead of single-run gates.

## Workflow Conventions

- Use the smallest repository script that covers the changed behavior.
- Run `npm run check:types` after TypeScript changes and `cargo clippy` after Rust changes.
- `npm run check` runs formatting and lint with fixes. Inspect and keep only task-related changes.
- Run `git diff --check` and inspect the final diff before reporting completion.

## Git Conventions

- Conventional commits, lowercase, no trailing period: `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`. Scope optional.
- Name the thing that changed, in the identifiers the codebase already uses. Prefer `feat: return annotation styles from Frame.render` over `feat: return the styles annotated markup needs`.
- State the change, not the reason for it. Leave `because`, `so that`, and `in order to` out of the subject.
- Write each message to stand alone for a reader who has not seen the task that produced it. Keep the body short: the problem, the resulting behavior, and one validation line.
- Never force push and never amend a pushed commit. Correct a mistake with a follow-up commit.

## UI Conventions

- Style with Zyzz. Keep a component's styles in a sibling `*.styles.ts` module of named `style` definitions, and separate adjacent definitions with one blank line. `erasableSyntaxOnly` rejects a `namespace styles` that holds values.
- Keep headless components free of styles. Skins and themes are separate entrypoints.
- Use accessible native controls with labels, visible focus, and `aria-live` for asynchronous status. Use an accessible primitive library only when a component needs coordinated behavior, such as a popup.
- Respect reduced-motion preferences. Animate `transform` and `opacity`.
- Keep components in the file that uses them until a second module needs them.

## Repository Layout

- `src/` holds flat PascalCase TypeScript modules for the host-agnostic API. `src/internal/` holds modules that no entrypoint exports.
- Each platform adapter is a lowercase folder that names its platform or role, such as `src/cloudflare/`, `src/vercel/`, `src/bash/`, `src/machines/`, `src/react/`, and `src/sandbox/`. Its own modules are flat PascalCase files, and its `index.ts` re-exports them as namespaces.
- `src/wasm.rs` and `src/wasm/` hold the WebAssembly crate. `interpreter/` holds the Python interpreter crate.
- `scripts/` holds build, release, and measurement scripts. `bench/` holds the optimization and eval harness. `examples/` holds runnable hosts of a public entrypoint, such as `examples/feedback`.

## Tooling

- Use npm. Declare every dependency at an exact version in `package.json`. Peer dependency ranges stay ranges. Hosts install `github:` commit pins with npm, which cannot resolve pnpm `catalog:` specifiers.
- Prettier is banned. Vite+ runs oxfmt and oxlint, configured in `vite.config.ts`.
- `tsc` builds the package. Each platform keeps its own tsconfig, since host-agnostic modules are checked against the web platform types only.

## Commands

- `npm run build` builds the WebAssembly module from source, then the TypeScript with `npm run build:ts`.
- `npm run check` runs `vp check --fix` for formatting and lint. `npm run check:types` runs `tsc` for every platform tsconfig.
- `node scripts/wasm.mjs` prints the WebAssembly fingerprint. `node scripts/publish-wasm.mjs` writes or uploads its release asset.
- `node scripts/release.mjs` publishes the pushed `HEAD` as the release `build-<short commit>`: it builds and uploads the WebAssembly release first when its fingerprint has none, then checks the types and packs the package.
- `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` check Rust.
