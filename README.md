<h1 align="center">nanocode-ts</h1>

<p align="center">
  <a href="https://nanocode.xyz/docs/guides/nanocode-ts">Guide</a> · <a href="https://nanocode.xyz/docs/api/wasm">API</a> · <a href="https://nanocode.xyz/cloudflare">Cloudflare Demo</a> · <a href="https://nanocode.xyz/vercel">Vercel Demo</a>
</p>

[nanocode](https://nanocode.xyz) agents in TypeScript: the Rust SDK compiled to one WebAssembly module, for Workers, Vercel Functions, Node and browsers. The module holds the agent. The host supplies SQL, model requests and tools.

<!-- ondine:eNpdkDFvgzAQhff-ihsbifQHZKiUrUOGtiB1sBAy5hJbNdj4jiAk__jagXRgsZ7k7957d1frZqVlYLh8vwBIpSrDFk9QaYRq8ViqYDyDdsRAOHQEyvW9zIIdcKJ-sD0TYd_aBXrXTRYLmLVRGpS0lqCV6heuLkD5dSkygRYCjhMSU5FMXGKSH-AdB6ZUImeJXXYNx-N73KLjliMGOTiVDJtZUv-WnzrNr5-PAWIX8OFu3S0CjVa8lqP9SI6HHaqZfUOcThGhM-QlKy2eYsfm0k3eLq79RTZc5Y5cl4rgp9Ya0tiJf5XJp39mwQd3Nx0G8bkJSEe7ScZZLvUf4TmZXA -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/README-1.dark.svg">
  <img alt="The TypeScript host sends commands to the WebAssembly module, which calls back for SQL, model requests, tools and events" src="assets/README-1.light.svg">
</picture>
<!-- /ondine -->

## Install

Each released commit has a tarball named after it.

```sh
npm install https://github.com/nanocodexyz/nanocode-ts/releases/download/build-<commit>/nanocode-ts-<commit>.tgz
```

## Entrypoints

| Import | Holds |
| --- | --- |
| `nanocode-ts` | `AgentRuntime` and its `Contracts`: the module over a SQL host |
| `nanocode-ts/cloudflare` | Sessions in Durable Objects, as in [durable-cloudflare](https://github.com/nanocodexyz/durable-cloudflare) |
| `nanocode-ts/vercel` | Sessions in Workflow runs, as in [durable-vercel](https://github.com/nanocodexyz/durable-vercel) |
| `nanocode-ts/client`, `nanocode-ts/react` | The browser client and the headless chat, styled by [nds](https://github.com/nanocodexyz/nds) |
| `nanocode-ts/bash` | The simulated shell that Code Mode cells run without a machine |
| `nanocode-ts/machines` | Tempo Wallet and MPP payments |

## License

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
