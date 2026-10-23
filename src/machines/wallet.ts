import { Mach, Provider, tempoWallet } from "accounts";
import { tempoWallet as deviceWallet } from "accounts/deviceCode";
import { KeyAuthorization } from "ox/tempo";
import { type Address, type Client, encodeFunctionData, type Hash, type Hex, isAddressEqual, toHex, type Transport } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { prepareTransactionRequest, sendRawTransactionSync, signTransaction } from "viem/actions";
import { Abis, Account, Actions, createClient, http } from "viem/tempo";
import { tempo } from "viem/tempo/chains";

export const mach = Mach.token;

export const usdc = { address: "0x20c000000000000000000000b9537d11c60e8b50", symbol: "USDC.e" } as const;

export const allowance = 2_000_000n;

export const feeAllowance = 100_000n;

export const lifetime = 86_400;

export const rpc = "https://rpc.tempo.xyz";

const escrow: Address = "0x4d50500000000000000000000000000000000000";

const swapper: Address = "0xF72E5107c32C655ffA7539a3C8e97B7C3cE16A3F";

const selectors = {
  approve: "0x095ea7b3",
  open: "0xedc53b00",
  requestClose: "0x675402e5",
  swapTo: "0x34189fed",
  topUp: "0xdc48471e",
  transferWithMemo: "0x95777d59",
  withdraw: "0x41e2c664",
} as const;

const storageKey = "nanocode.machines.wallet";

export type Wallet = {
  address: Address;
  authorization: KeyAuthorization.Rpc;
  expiry: number;
  key: Hex;
  keyAddress: Address;
};

export type Prompt = { userCode: string; verificationUri: string; verificationUriFull: string | undefined };

export type Options = { name: string; relay: string; websiteUrl: string };

let options: Options = { name: "nanocode machines", relay: "api/device/", websiteUrl: "https://nanocode.xyz/machines/" };

export function configure(next: Partial<Options>) {
  options = { ...options, ...next };
  provider = undefined;
}

let provider: ReturnType<typeof Provider.create> | undefined;

let prompt: (prompt: Prompt) => void = () => {};

export function framed() {
  return document.documentElement.hasAttribute("data-xframe");
}

let formsBlocked: boolean | undefined;

export function sandboxed() {
  if (formsBlocked !== undefined) return formsBlocked;
  const form = document.createElement("form");
  let submitted = false;
  form.addEventListener("submit", event => {
    submitted = true;
    event.preventDefault();
  });
  document.body.append(form);
  form.requestSubmit();
  form.remove();
  formsBlocked = !submitted;
  return formsBlocked;
}

export function onPrompt(listener: (prompt: Prompt) => void) {
  prompt = listener;
  return () => {
    prompt = () => {};
  };
}

function relay(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input instanceof Request ? input.url : input);
  const device = "https://wallet.tempo.xyz/api/auth/device/";
  return fetch(url.startsWith(device) ? new URL(`${options.relay}${url.slice(device.length)}`, location.href) : input, init);
}

function wallet() {
  provider ??= Provider.create({
    adapter: framed()
      ? deviceWallet({ fetch: relay as typeof fetch, meta: { name: options.name, websiteUrl: options.websiteUrl }, onPrompt: next => prompt(next) })
      : tempoWallet(),
    mpp: false,
  });
  return provider;
}

export function reader(): Client<Transport, typeof tempo> {
  return createClient({ chain: tempo, transport: http(rpc) });
}

export function restore(): Wallet | undefined {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return undefined;
  const parsed = JSON.parse(saved) as Wallet;
  const fees = parsed.authorization.limits?.some(limit => isAddressEqual(limit.token, usdc.address));
  if (parsed.expiry * 1000 > Date.now() && fees) return parsed;
  localStorage.removeItem(storageKey);
  return undefined;
}

export async function connect(): Promise<Wallet> {
  const key = generatePrivateKey();
  const access = Account.fromSecp256k1(key);
  const expiry = Math.floor(Date.now() / 1000) + lifetime;
  const request = {
    address: access.address,
    chainId: toHex(tempo.id),
    expiry,
    keyType: "secp256k1",
    limits: [{ limit: toHex(allowance), token: mach.address }, { limit: toHex(feeAllowance), token: usdc.address }],
    publicKey: access.publicKey,
    scopes: [
      { address: mach.address, selector: selectors.transferWithMemo },
      { address: mach.address, recipients: [swapper], selector: selectors.approve },
      { address: swapper, selector: selectors.swapTo },
      ...[selectors.open, selectors.topUp, selectors.requestClose, selectors.withdraw].map(selector => ({ address: escrow, selector })),
    ],
  };
  const result = (await wallet().request({ method: "wallet_connect", params: [{ capabilities: { authorizeAccessKey: request }, chainId: tempo.id }] } as never)) as {
    accounts: readonly { address: Address; capabilities?: { keyAuthorization?: KeyAuthorization.Rpc } }[];
  };
  const account = result.accounts[0];
  const authorization = account?.capabilities?.keyAuthorization;
  if (!account || !authorization) throw new Error("Tempo Wallet returned no approval.");
  const connected: Wallet = { address: account.address, authorization, expiry, key, keyAddress: access.address };
  localStorage.setItem(storageKey, JSON.stringify(connected));
  return connected;
}

export async function published(connected: Wallet) {
  const metadata = await Actions.accessKey.getMetadata(reader(), { accessKey: connected.keyAddress, account: connected.address });
  return isAddressEqual(metadata.address, connected.keyAddress) && !metadata.isRevoked;
}

export async function publish(connected: Wallet): Promise<Hash | undefined> {
  if (await published(connected)) return undefined;
  const client = reader();
  const account = signer(connected);
  const request = await prepareTransactionRequest(client, {
    account,
    calls: [{ data: encodeFunctionData({ abi: Abis.tip20, args: [swapper, 0n], functionName: "approve" }), to: mach.address }],
    feeToken: usdc.address,
    keyAuthorization: KeyAuthorization.fromRpc(connected.authorization),
    nonceKey: "expiring",
  } as never);
  const receipt = await sendRawTransactionSync(client, { serializedTransaction: await signTransaction(client, request as never) });
  if (receipt.status !== "success") throw new Error(`Tempo did not accept the key (transaction ${receipt.transactionHash}).`);
  return receipt.transactionHash;
}

export async function revoke(connected: Wallet) {
  await wallet().request({ method: "wallet_revokeAccessKey", params: [{ accessKeyAddress: connected.keyAddress, address: connected.address, chainId: toHex(tempo.id) }] } as never);
}

export function forget() {
  localStorage.removeItem(storageKey);
}

export function fund(connected: Wallet) {
  return Mach.fund(wallet(), { address: connected.address, displayName: options.name });
}

export function fundingUrl(connected: Wallet) {
  return Mach.getFundingUrl({ address: connected.address });
}

export function signer(connected: Wallet) {
  return Account.fromSecp256k1(connected.key, { access: connected.address });
}

export async function balances(connected: Wallet) {
  const client = reader();
  const [balance, fees, remaining] = await Promise.all([
    Actions.token.getBalance(client, { account: connected.address, token: mach.address }),
    Actions.token.getBalance(client, { account: connected.address, token: usdc.address }),
    Actions.accessKey.getRemainingLimit(client, { accessKey: connected.keyAddress, account: connected.address, token: mach.address }).then(limit => limit.remaining, () => allowance),
  ]);
  return { balance: balance.amount, fees: fees.amount, remaining };
}

export function short(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function format(atomics: bigint) {
  return `${atomics / 1_000_000n}.${(atomics % 1_000_000n).toString().padStart(6, "0")}`;
}
