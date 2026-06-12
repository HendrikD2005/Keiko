import { spawn } from "node:child_process";
import {
  AuthenticationError,
  CancelledError,
  ConfigInvalidError,
  ProviderError,
  TransportError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import type { ModelCapability } from "./types.js";
import { createDefaultChatCapability } from "./capabilities.js";

const DEFAULT_CODEX_EXECUTABLE = "codex";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type CodexApprovedCommand =
  | "version"
  | "login-status"
  | "doctor-json"
  | "debug-models"
  | "exec-json";

export interface CodexCliCommandInput {
  readonly command: CodexApprovedCommand;
  readonly executable?: string | undefined;
  readonly modelId?: string | undefined;
  readonly stdinText?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly cwd?: string | undefined;
}

export interface CodexCliCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly terminatedBySignal: string | null;
}

export type CodexCliCommandRunner = (
  input: CodexCliCommandInput,
) => Promise<CodexCliCommandResult>;

export interface CodexExecUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface CodexExecResult {
  readonly content: string;
  readonly usage: CodexExecUsage;
}

interface CodexCheckDetails {
  readonly status?: string | undefined;
  readonly summary?: string | undefined;
  readonly details?: Readonly<Record<string, string>> | undefined;
}

interface CodexDoctorReport {
  readonly overallStatus?: string | undefined;
  readonly codexVersion?: string | undefined;
  readonly checks?: Readonly<Record<string, CodexCheckDetails>> | undefined;
}

interface CodexModelCatalogEntry {
  readonly slug: string;
  readonly visibility?: string | undefined;
  readonly supported_in_api?: boolean | undefined;
  readonly shell_type?: string | undefined;
  readonly description?: string | undefined;
}

interface CodexModelCatalog {
  readonly models?: readonly CodexModelCatalogEntry[] | undefined;
}

function argsFor(
  command: CodexApprovedCommand,
  modelId: string | undefined,
): readonly string[] {
  switch (command) {
    case "version":
      return ["--version"];
    case "login-status":
      return ["login", "status"];
    case "doctor-json":
      return ["doctor", "--json"];
    case "debug-models":
      return ["debug", "models"];
    case "exec-json":
      if (modelId === undefined || modelId.length === 0) {
        throw new ConfigInvalidError("codex local-session execution requires a configured model id");
      }
      return [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--model",
        modelId,
        "-",
      ];
  }
}

function errorSnippet(output: string): string {
  return output
    .trim()
    .split(/\r?\n/u)
    .slice(0, 3)
    .join(" ")
    .slice(0, 240);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(stdout: string, label: string, version: string | undefined): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    const versionHint = version === undefined ? "unknown version" : `version '${version}'`;
    throw new ConfigInvalidError(
      `codex CLI ${versionHint} did not return valid JSON for ${label}`,
    );
  }
}

function isAuthenticationFailure(text: string): boolean {
  return /(login|logged in|auth|session|token|credential)/u.test(text);
}

function isUnsupportedCliInterface(text: string): boolean {
  return /(unknown option|unexpected argument|unrecognized|invalid value|usage: codex)/u.test(
    text,
  );
}

function classifyExecFailure(
  stderr: string,
  exitCode: number,
  modelId: string,
): ProviderError | AuthenticationError | ConfigInvalidError {
  const signal = stderr.toLowerCase();
  if (isAuthenticationFailure(signal)) {
    return new AuthenticationError(
      `codex local session is not authenticated for '${modelId}'`,
    );
  }
  if (isUnsupportedCliInterface(signal)) {
    return new ConfigInvalidError(
      `codex CLI does not support the required local-session machine interface for '${modelId}'`,
    );
  }
  return new ProviderError(
    `codex local-session execution failed for '${modelId}' (exit ${String(exitCode)})`,
    502,
  );
}

function parseVersionString(stdout: string): string {
  const version = stdout.trim();
  if (version.length === 0) {
    throw new ConfigInvalidError("codex CLI returned an empty version string");
  }
  return version;
}

function doctorAuthStatus(doctor: CodexDoctorReport): string | undefined {
  return doctor.checks?.["auth.credentials"]?.status;
}

function doctorWebsocketCheck(doctor: CodexDoctorReport): CodexCheckDetails | undefined {
  return doctor.checks?.["network.websocket_reachability"];
}

function classifyDoctorFailure(
  doctor: CodexDoctorReport,
  modelId: string,
): AuthenticationError | ProviderError {
  if (doctorAuthStatus(doctor) !== "ok") {
    throw new AuthenticationError(`codex local session is not authenticated for '${modelId}'`);
  }
  const websocket = doctorWebsocketCheck(doctor);
  if (websocket?.status !== "ok") {
    const summary = (websocket?.summary ?? "").toLowerCase();
    if (isAuthenticationFailure(summary)) {
      throw new AuthenticationError(
        `codex local session is not ready to serve '${modelId}'`,
      );
    }
    throw new ProviderError(
      `codex local session is not reachable for '${modelId}'`,
      503,
    );
  }
  if (doctor.overallStatus === "fail") {
    throw new ProviderError(
      `codex local session health checks failed for '${modelId}'`,
      503,
    );
  }
  return new ProviderError(`codex local session is unavailable for '${modelId}'`, 503);
}

interface ParsedExecEvent {
  readonly type: string;
  readonly item?: Readonly<Record<string, unknown>> | undefined;
  readonly usage?: Readonly<Record<string, unknown>> | undefined;
}

function parseExecEventLine(line: string): ParsedExecEvent | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isJsonRecord(event) || typeof event.type !== "string") {
    return undefined;
  }
  return {
    type: event.type,
    ...(isJsonRecord(event.item) ? { item: event.item } : {}),
    ...(isJsonRecord(event.usage) ? { usage: event.usage } : {}),
  };
}

function updateExecState(
  state: { latestContent: string | undefined; usage: CodexExecUsage },
  event: ParsedExecEvent,
): void {
  if (
    event.type === "item.completed" &&
    event.item?.type === "agent_message" &&
    typeof event.item.text === "string"
  ) {
    state.latestContent = event.item.text;
    return;
  }
  if (event.type === "turn.completed" && event.usage !== undefined) {
    state.usage = {
      promptTokens: typeof event.usage.input_tokens === "number" ? event.usage.input_tokens : 0,
      completionTokens:
        typeof event.usage.output_tokens === "number" ? event.usage.output_tokens : 0,
    };
  }
}

function parseExecJsonl(stdout: string, modelId: string): CodexExecResult {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const state: { latestContent: string | undefined; usage: CodexExecUsage } = {
    latestContent: undefined,
    usage: { promptTokens: 0, completionTokens: 0 },
  };
  for (const line of lines) {
    const event = parseExecEventLine(line);
    if (event === undefined) {
      continue;
    }
    updateExecState(state, event);
  }
  if (state.latestContent === undefined) {
    throw new ProviderError(
      `codex local session returned no assistant message for '${modelId}'`,
      502,
    );
  }
  return { content: state.latestContent, usage: state.usage };
}

function mapCatalogEntryToCapability(entry: CodexModelCatalogEntry): ModelCapability {
  const slug = entry.slug;
  const defaultCapability = createDefaultChatCapability(slug);
  const isMiniModel = slug.includes("mini");
  const costClass =
    isMiniModel ? "low" : slug.endsWith("gpt-5.4") || slug.endsWith("gpt-5.5") ? "high" : "medium";
  const latencyClass = isMiniModel ? "fast" : "standard";
  return {
    ...defaultCapability,
    toolCalling: false,
    structuredOutput: true,
    streaming: false,
    workflowEligible: entry.shell_type === "shell_command",
    costClass,
    latencyClass,
    throughputHint: "Codex local session",
    preferredUseCases:
      entry.shell_type === "shell_command"
        ? ["Local coding workflow"]
        : ["Chat"],
    knownLimitations: [
      "Gateway tool-call bridging is not available through the local Codex session provider",
      "Streaming is synthesized from buffered local-session execution",
      "Structured output is enforced by prompt instructions and JSON parsing",
      ...(entry.description === undefined ? [] : [entry.description]),
    ],
    supportsSeeding: false,
    supportsResponseFormat: true,
  };
}

function createFinish(): (fn: () => void) => void {
  let settled = false;
  return (fn: () => void): void => {
    if (settled) {
      return;
    }
    settled = true;
    fn();
  };
}

function rejectOutputOverflow(
  child: ReturnType<typeof spawn>,
  finish: (fn: () => void) => void,
  reject: (reason: ProviderError) => void,
  message: string,
): void {
  child.kill("SIGTERM");
  finish(() => {
    reject(new ProviderError(message, 502));
  });
}

function appendBoundedChunk(
  child: ReturnType<typeof spawn>,
  finish: (fn: () => void) => void,
  reject: (reason: ProviderError) => void,
  current: string,
  chunk: Buffer,
  nextBytes: number,
  overflowMessage: string,
): string {
  if (nextBytes > MAX_OUTPUT_BYTES) {
    rejectOutputOverflow(child, finish, reject, overflowMessage);
    return current;
  }
  return current + chunk.toString("utf8");
}

function requirePipedStream<T>(stream: T | null, name: "stdin" | "stdout" | "stderr"): T {
  if (stream === null) {
    throw new TransportError(`codex CLI ${name} pipe was not created`);
  }
  return stream;
}

function spawnCodexChild(input: CodexCliCommandInput): ReturnType<typeof spawn> {
  const executable = input.executable ?? DEFAULT_CODEX_EXECUTABLE;
  return spawn(executable, argsFor(input.command, input.modelId), {
    cwd: input.cwd ?? process.cwd(),
    env: process.env,
    shell: false,
    stdio: "pipe",
  });
}

function attachOutputHandlers(
  child: ReturnType<typeof spawn>,
  finish: (fn: () => void) => void,
  reject: (reason: ProviderError) => void,
): {
  readonly readStdout: () => string;
  readonly readStderr: () => string;
} {
  const stdoutStream = requirePipedStream(child.stdout, "stdout");
  const stderrStream = requirePipedStream(child.stderr, "stderr");
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  stdoutStream.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    stdout = appendBoundedChunk(
      child,
      finish,
      reject,
      stdout,
      chunk,
      stdoutBytes,
      "codex CLI output exceeded the safety limit",
    );
  });
  stderrStream.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderr = appendBoundedChunk(
      child,
      finish,
      reject,
      stderr,
      chunk,
      stderrBytes,
      "codex CLI stderr exceeded the safety limit",
    );
  });
  return {
    readStdout: (): string => stdout,
    readStderr: (): string => stderr,
  };
}

function runCodexCommandProcess(
  input: CodexCliCommandInput,
  resolve: (result: CodexCliCommandResult) => void,
  reject: (reason: Error) => void,
): void {
  const child = spawnCodexChild(input);
  const finish = createFinish();
  const { readStdout, readStderr } = attachOutputHandlers(child, finish, reject);
  const onAbort = (): void => {
    child.kill("SIGTERM");
    finish(() => {
      reject(new CancelledError(`codex ${input.command} was cancelled`));
    });
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  child.on("error", (error) => {
    input.signal?.removeEventListener("abort", onAbort);
    finish(() => {
      reject(
        new TransportError(
          `codex CLI could not be started: ${error instanceof Error ? error.message : "unknown error"}`,
        ),
      );
    });
  });
  child.on("close", (exitCode, signal) => {
    input.signal?.removeEventListener("abort", onAbort);
    finish(() => {
      resolve({
        stdout: readStdout(),
        stderr: readStderr(),
        exitCode: exitCode ?? 1,
        terminatedBySignal: signal,
      });
    });
  });
  if (input.stdinText !== undefined) {
    requirePipedStream(child.stdin, "stdin").write(input.stdinText);
  }
  requirePipedStream(child.stdin, "stdin").end();
}

export const defaultCodexCliCommandRunner: CodexCliCommandRunner = function defaultCodexCliCommandRunner(
  input,
) {
  return new Promise<CodexCliCommandResult>((resolve, reject) => {
    runCodexCommandProcess(input, resolve, reject);
  });
};

export interface CodexCliClientDeps {
  readonly commandRunner?: CodexCliCommandRunner | undefined;
  readonly executable?: string | undefined;
  readonly cwd?: string | undefined;
}

export class CodexCliClient {
  private readonly commandRunner: CodexCliCommandRunner;
  private readonly executable: string | undefined;
  private readonly cwd: string | undefined;
  private versionPromise: Promise<string> | undefined;
  private doctorPromise: Promise<CodexDoctorReport> | undefined;

  constructor(deps: CodexCliClientDeps = {}) {
    this.commandRunner = deps.commandRunner ?? defaultCodexCliCommandRunner;
    this.executable = deps.executable;
    this.cwd = deps.cwd;
  }

  private async run(
    command: CodexApprovedCommand,
    input: Omit<CodexCliCommandInput, "command" | "executable" | "cwd"> = {},
  ): Promise<CodexCliCommandResult> {
    return this.commandRunner({
      command,
      executable: this.executable,
      cwd: this.cwd,
      ...input,
    });
  }

  async version(): Promise<string> {
    this.versionPromise ??= (async (): Promise<string> => {
      const result = await this.run("version");
      if (result.exitCode !== 0) {
        throw new ConfigInvalidError(
          `codex CLI version check failed: ${errorSnippet(result.stderr || result.stdout)}`,
        );
      }
      return parseVersionString(result.stdout);
    })();
    return this.versionPromise;
  }

  async loginStatus(signal?: AbortSignal): Promise<string> {
    const result = await this.run("login-status", { signal });
    if (result.exitCode !== 0) {
      throw new AuthenticationError("codex local session is not logged in");
    }
    const status = result.stdout.trim();
    if (status.length === 0) {
      throw new AuthenticationError("codex local session login status is unavailable");
    }
    return status;
  }

  async doctor(signal?: AbortSignal): Promise<CodexDoctorReport> {
    this.doctorPromise ??= (async (): Promise<CodexDoctorReport> => {
      const version = await this.version();
      const result = await this.run("doctor-json", { signal });
      if (result.exitCode !== 0) {
        throw new ConfigInvalidError(
          `codex CLI ${version} does not support the required doctor JSON interface`,
        );
      }
      return parseJson(
        result.stdout,
        "`codex doctor --json`",
        version,
      ) as CodexDoctorReport;
    })();
    return this.doctorPromise;
  }

  async ensureReady(modelId: string, signal?: AbortSignal): Promise<void> {
    const doctor = await this.doctor(signal);
    const authStatus = doctorAuthStatus(doctor);
    const websocketStatus = doctorWebsocketCheck(doctor)?.status;
    if (authStatus !== "ok") {
      await this.loginStatus(signal);
    }
    if (authStatus !== "ok" || websocketStatus !== "ok" || doctor.overallStatus === "fail") {
      throw classifyDoctorFailure(doctor, modelId);
    }
  }

  async discoverCapabilities(signal?: AbortSignal): Promise<readonly ModelCapability[]> {
    const version = await this.version();
    const result = await this.run("debug-models", { signal });
    if (result.exitCode !== 0) {
      throw new ConfigInvalidError(
        `codex CLI ${version} does not support the required model discovery interface`,
      );
    }
    const catalog = parseJson(
      result.stdout,
      "`codex debug models`",
      version,
    ) as CodexModelCatalog;
    return (catalog.models ?? [])
      .filter((entry) => entry.supported_in_api !== false)
      .filter((entry) => entry.visibility !== "hide")
      .map(mapCatalogEntryToCapability);
  }

  async execJson(
    modelId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<CodexExecResult> {
    const result = await this.run("exec-json", {
      modelId,
      stdinText: prompt,
      signal,
    });
    if (result.exitCode !== 0) {
      throw classifyExecFailure(result.stderr || result.stdout, result.exitCode, modelId);
    }
    return parseExecJsonl(result.stdout, modelId);
  }
}
