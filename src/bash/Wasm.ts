export type Options = {
  force?: boolean
  fuel?: number
  interpreter?: WebAssembly.Module | Promise<WebAssembly.Module>
  memoryBytes?: number
}
