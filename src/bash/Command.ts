/**
 * Contract of shell commands: the context that a handler receives, its errors, and the streaming
 * marker. Hosts pass handlers to `Bash.create` as `commands`.
 *
 * @module
 */
export { CommandError, PipeError, streaming } from './internal/Shell.ts'
export type { CommandContext as Context, CommandHandler as Handler } from './internal/Shell.ts'
