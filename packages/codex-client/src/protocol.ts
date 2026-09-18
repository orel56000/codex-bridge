/**
 * Codex App Server protocol types.
 *
 * These are a hand-maintained subset of the bindings the Codex CLI itself emits:
 *
 *     codex app-server generate-ts           --out <dir>
 *     codex app-server generate-json-schema  --experimental --out <dir>
 *
 * `npm run protocol:check` regenerates them and diffs the method names against
 * {@link CLIENT_REQUEST_METHODS} so a Codex upgrade that renames a method fails
 * loudly instead of silently at runtime.
 *
 * Verified against codex-cli 0.154.0-alpha.6.2.
 */

/* --------------------------------- JSON-RPC -------------------------------- */

export type RequestId = string | number;

export interface JsonRpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  id: RequestId;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  id: RequestId;
  error: JsonRpcErrorBody;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

/* ------------------------------- initialize -------------------------------- */

export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

export interface InitializeCapabilities {
  experimentalApi: boolean;
  requestAttestation: boolean;
  optOutNotificationMethods?: string[] | null;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

/* --------------------------------- account --------------------------------- */

export type PlanType = string;

export type Account =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: PlanType }
  | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean };

export interface GetAccountResponse {
  account: Account | null;
  requiresOpenaiAuth: boolean;
}

export type LoginAccountParams =
  | { type: 'chatgpt'; codexStreamlinedLogin?: boolean; useHostedLoginSuccessPage?: boolean; appBrand?: string | null }
  | { type: 'chatgptDeviceCode' }
  | { type: 'apiKey'; apiKey: string };

export type LoginAccountResponse =
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: 'chatgptDeviceCode'; loginId: string; verificationUrl: string; userCode: string }
  | { type: 'apiKey' };

export interface AccountLoginCompletedNotification {
  loginId: string | null;
  success: boolean;
  error: string | null;
}

export interface AccountUpdatedNotification {
  authMode: string | null;
  planType: PlanType | null;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
}

export interface CreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: number | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  planType: PlanType | null;
  rateLimitReachedType: string | null;
  spendControlReached: boolean | null;
}

export interface GetAccountRateLimitsResponse {
  ordinaryUsageAllowed: boolean | null;
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
  accountId: string | null;
}

/* ---------------------------------- models --------------------------------- */

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: Array<{ effort: ReasoningEffort; description?: string }>;
  inputModalities: string[];
}

export interface ModelListResponse {
  data: CodexModel[];
  nextCursor: string | null;
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | string;

/* --------------------------------- threads --------------------------------- */

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type AskForApproval = 'untrusted' | 'on-request' | 'never';

export interface DynamicToolFunctionSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

export type DynamicToolSpec = DynamicToolFunctionSpec;

export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  /** Requires `capabilities.experimentalApi = true` on `initialize`. */
  dynamicTools?: DynamicToolSpec[] | null;
}

export interface Thread {
  id: string;
  [k: string]: unknown;
}

export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  reasoningEffort: ReasoningEffort | null;
}

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  baseInstructions?: string | null;
  model?: string | null;
}

/* ---------------------------------- turns ---------------------------------- */

export type UserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'image'; url: string; detail?: 'low' | 'high' | 'auto' }
  | { type: 'localImage'; path: string };

/**
 * Responses-API function output. Verified against the generated bindings:
 * a bare string, or a list of content items — NOT an object with `content`.
 */
export type FunctionCallOutputContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_audio'; audio_url: string };

export type FunctionCallOutputBody = string | FunctionCallOutputContentItem[];

export interface TurnToolOutput {
  name: string;
  namespace: string | null;
  output: FunctionCallOutputBody;
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  clientUserMessageId?: string | null;
  toolOutput?: TurnToolOutput | null;
  model?: string | null;
  effort?: ReasoningEffort | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  outputSchema?: unknown;
}

export interface Turn {
  id: string;
  status: 'inProgress' | 'completed' | 'failed' | 'cancelled' | string;
  error: unknown | null;
  items?: ThreadItem[];
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

/* -------------------------------- thread items ------------------------------ */

export type DynamicToolCallStatus = 'inProgress' | 'completed' | 'failed';

export interface AgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
  phase: string | null;
}

export interface ReasoningItem {
  type: 'reasoning';
  id: string;
  summary: string[];
  content: string[];
}

export interface DynamicToolCallItem {
  type: 'dynamicToolCall';
  id: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
  status: DynamicToolCallStatus;
  success: boolean | null;
  durationMs: number | null;
}

export interface CommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  cwd: string;
  status: string;
  aggregatedOutput: string | null;
  exitCode: number | null;
}

export interface FileChangeItem {
  type: 'fileChange';
  id: string;
  changes: unknown[];
  status: string;
}

export type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | DynamicToolCallItem
  | CommandExecutionItem
  | FileChangeItem
  | { type: string; id: string; [k: string]: unknown };

/* ------------------------------ notifications ------------------------------- */

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ReasoningDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ItemLifecycleNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface TurnLifecycleNotification {
  threadId: string;
  turn: Turn;
}

export interface TurnError {
  message?: string;
  type?: string;
  [k: string]: unknown;
}

export interface ErrorNotification {
  error: TurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

export interface TokenUsageNotification {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: TokenUsage;
    last: TokenUsage;
  };
}

export interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface RateLimitsUpdatedNotification {
  rateLimits: RateLimitSnapshot;
}

/* ----------------------------- server requests ------------------------------ */

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export type DynamicToolCallOutputContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }
  | { type: 'inputAudio'; audioUrl: string };

export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
}

export type CommandExecutionApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

/* -------------------------------- constants -------------------------------- */

/** Methods this client sends. Checked against the generated protocol in CI. */
export const CLIENT_REQUEST_METHODS = [
  'initialize',
  'account/read',
  'account/login/start',
  'account/login/cancel',
  'account/logout',
  'account/rateLimits/read',
  'model/list',
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/interrupt',
] as const;

/** Server → client notifications this client understands. */
export const SERVER_NOTIFICATION_METHODS = [
  'error',
  'thread/started',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'thread/tokenUsage/updated',
  'account/updated',
  'account/login/completed',
  'account/rateLimits/updated',
] as const;

/** Server → client requests this client answers. */
export const SERVER_REQUEST_METHODS = [
  'item/tool/call',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'execCommandApproval',
  'applyPatchApproval',
] as const;
