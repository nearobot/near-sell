import type { KeyPair } from 'near-api-js';

export type Mode = 'paper' | 'live';
export type Metric = 'marketcap' | 'holding';
export type Direction = 'gte' | 'lte';
export interface Quantity { kind: 'percent' | 'tokens'; value: string }
export interface TargetConfig {
  account: string; token: string; metric: Metric; direction: Direction; threshold: string;
  quantity: Quantity; slippageBps: number; maxImpactBps: number; settlement: 'near' | 'pair'; mode: Mode;
}
export type TargetInput = Omit<TargetConfig, 'mode' | 'settlement'> & Partial<Pick<TargetConfig, 'mode' | 'settlement'>>;
export type TargetStatus = 'draft' | 'active' | 'executing' | 'paused' | 'cancelled' | 'expired' | 'filled' | 'refunded' | 'needs_review' | 'simulated' | 'rejected';
export interface Target extends TargetConfig {
  id: string; status: TargetStatus; createdAt: number; expiresAt: number; updatedAt?: number;
  executionId?: string; lastError?: string | null; lastCheckedAt?: number; finishedAt?: number;
}
export interface Block { hash: string; height: number; at: number }
export interface TokenMetadata { symbol: string; name: string; decimals: number }
export interface CurveState {
  real_reserve: string; virtual_reserve: string; curve_tokens: string; fee_bps: number; graduated: boolean;
  quote_token?: string | null; spot_price: string;
  migration?: 'NotStarted' | { Done?: { pool_id: number } };
  dex?: { exchange: string; wrap_near?: string; staked_near?: string };
}
export interface RouteBase { token: string; output: string; outSymbol: string; outDecimals: number; outUsd: string }
export interface DclRoute extends RouteBase { kind: 'dcl'; exchange: string; poolId: string; sellTaxBps: number }
export interface CurveRoute extends RouteBase { kind: 'curve'; curve: CurveState }
export interface RheaRoute extends RouteBase { kind: 'rhea'; exchange: string; poolId: number }
export type Route = DclRoute | CurveRoute | RheaRoute;
export interface Pricing extends TokenMetadata { priceUsd: string; marketCapUsd: string; priceSource: string; rateAt: number; route: Route }
export interface Snapshot extends Pricing { token: string; account: string; balanceRaw: string; observedAt: number; blockAt: number; block: Block }
export interface Valuation { priceUsd: string | null; marketCapUsd: string | null; balanceRaw: string; decimals: number }
export interface Holding {
  token: string; symbol: string; decimals?: number; balanceRaw: string | null; priceUsd: string | null;
  valueUsd: string | null; route?: Route | null; warning?: string;
}
export interface Portfolio { account: string; at: number; blockAt: number; tokens: Holding[]; warning: string | null; totalUsd: string; unpriced: number }
export interface PlanBase {
  account: string; token: string; symbol: string; receiver: string; gas: string; deposit: string;
  output: string; outSymbol: string; quotedAt: number; blockAt: number;
}
export interface RegistrationPlan extends PlanBase {
  kind: 'registration'; method: 'storage_deposit'; args: { account_id: string; registration_only: true };
}
export interface SellBase extends PlanBase {
  amount: string; decimals: number; outDecimals: number; expectedOut: string; minimumOut: string; impactBps: number;
  registration?: RegistrationPlan | null;
}
export interface CurvePlan extends SellBase { kind: 'curve'; method: 'sell'; args: { amount: string; min_out: string } }
export interface FtPlan extends SellBase { kind: 'ft'; method: 'ft_transfer_call'; args: { receiver_id: string; amount: string; msg: string } }
export type SellPlan = CurvePlan | FtPlan;
export type Plan = SellPlan | RegistrationPlan;
export interface PreparedTransaction { key: KeyPair; nonce: bigint; blockHash: string }
export interface SignedPayload { hash: string; payload: string }
export type ExecutionStatus = 'preparing' | 'signed' | 'pending' | 'uncertain' | 'filled' | 'needs_review' | 'refunded' | 'registered' | 'simulated' | 'paused' | 'rejected' | 'reviewed';
export type FinishedStatus = Extract<ExecutionStatus, 'filled' | 'needs_review' | 'refunded' | 'registered' | 'simulated' | 'paused' | 'rejected'>;
export interface Execution {
  id: string; targetId: string; account: string; status: ExecutionStatus; plan: Plan; createdAt: number;
  hash?: string; payload?: string; reason?: string; actualOut?: string; updatedAt?: number; broadcastAt?: number;
}
export interface Outcome { status: 'pending' | 'uncertain' | 'needs_review' | 'registered' | 'filled' | 'refunded'; reason?: string; actualOut?: string }
export interface Receipt { outcome?: { executor_id?: string; logs?: string[]; status?: { Failure?: unknown; SuccessValue?: string } } }
export interface TransactionResult { final_execution_status?: string; status?: { Failure?: unknown; SuccessValue?: string }; transaction_outcome?: Receipt; receipts_outcome?: Receipt[] }
export interface RpcPort {
  call<T = unknown>(method: string, params: unknown, options?: { write?: boolean }): Promise<T>;
  query<T = unknown>(args: Record<string, unknown>, block?: Block): Promise<T>;
  view<T = unknown>(contract: string, method: string, args?: Record<string, unknown>, block?: Block): Promise<T>;
  block(): Promise<Block>;
  status(hash: string, account: string): Promise<TransactionResult>;
}
export interface AccountState { amount: string; locked: string; storage_usage: number }
export interface ProtocolConfig { runtime_config: { storage_amount_per_byte: string } }
export interface AccessKey { permission: unknown; nonce: number; block_hash: string }
export interface NearlyLaunch { token: string; id: number; quote: string; pool_id: string; total_supply: string; step: string; inflight: boolean }
export interface SimplePool { pool_kind: string; token_account_ids: string[]; amounts: string[] }
export interface PriceList { [token: string]: { price: string; symbol: string; decimal: number } }
export interface FetchResponse { ok: boolean; status: number; json(): Promise<unknown> }
export type FetchLike = (url: string, options?: RequestInit) => Promise<FetchResponse>;
export interface VaultEnvelope { version: number; salt: string; iv: string; tag: string; cipher: string }
export interface Wallet { account: string; publicKey: string; secretKey: string; hd: string }
export interface VaultData { token: string; owner: string; fastnearApiKey: string; wallets: Wallet[] }
export interface Settings { selectedWallet: string; paused: boolean; telegramOffset: number; slippageBps: number; maxImpactBps: number }
export interface InlineButton { text: string; callback_data: string }
export interface InlineKeyboard { inline_keyboard: InlineButton[][] }
export interface TelegramUser { id: number; is_bot?: boolean }
export interface TelegramMessage { message_id?: number; chat: { id: number; type: string }; from?: TelegramUser; text?: string }
export interface TelegramUpdate { update_id?: number; message?: TelegramMessage; callback_query?: { id: string; from?: TelegramUser; message?: TelegramMessage; data?: string } }
export interface TelegramMethods { getMe: { username: string }; getWebhookInfo: { url: string }; getUpdates: TelegramUpdate[]; answerCallbackQuery: boolean; sendMessage: unknown; editMessageText: unknown; setMyCommands: boolean }
export interface MessageOptions { parse_mode?: 'HTML' }
export interface TelegramPort {
  call<K extends keyof TelegramMethods>(method: K, body?: Record<string, unknown>): Promise<TelegramMethods[K]>;
  send(chat: string, text: string, markup?: InlineKeyboard, options?: MessageOptions): Promise<unknown>;
}
