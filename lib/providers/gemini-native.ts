/**
 * Gemini 原生 REST 健康检查
 *
 * 目的：让 type=gemini 不再依赖 OpenAI 兼容层（避免 "No available providers" 等问题），
 * 直接调用 Gemini v1beta 的 streamGenerateContent / generateContent。
 */

import type { CheckResult, HealthStatus, ProviderConfig } from "../types";
import { DEFAULT_ENDPOINTS } from "../types";
import { getErrorMessage } from "../utils/error-handler";
import { generateChallenge, validateResponse } from "./challenge";
import { measureEndpointPing } from "./endpoint-ping";

/** 默认超时时间（毫秒） */
const DEFAULT_TIMEOUT_MS = 45_000;

/** 性能降级阈值（毫秒），可通过 DEGRADED_THRESHOLD_MS 环境变量覆写 */
const DEGRADED_THRESHOLD_MS = Number(process.env.DEGRADED_THRESHOLD_MS) || 6_000;

type GeminiAction = "streamGenerateContent" | "generateContent";

interface GeminiApiError extends Error {
  statusCode?: number;
  responseBody?: string;
}

function createGeminiApiError(
  statusCode: number,
  responseBody: string,
  message?: string
): GeminiApiError {
  const error = new Error(message ?? `Gemini API 请求失败 (${statusCode})`) as GeminiApiError;
  error.statusCode = statusCode;
  error.responseBody = responseBody;
  return error;
}

function resolveGeminiUrlForAction(
  endpoint: string,
  model: string,
  action: GeminiAction
): string {
  const trimmed = endpoint.trim();
  const [base, query = ""] = trimmed.split("?");
  const normalizedBase = base.replace(/\/+$/, "");
  const withQuery = (nextBase: string) => (query ? `${nextBase}?${query}` : nextBase);

  if (action === "streamGenerateContent") {
    if (trimmed.includes(":streamGenerateContent")) {
      return trimmed;
    }
  } else {
    if (trimmed.includes(":generateContent")) {
      return trimmed;
    }
    if (trimmed.includes(":streamGenerateContent")) {
      return withQuery(base.replace(":streamGenerateContent", ":generateContent"));
    }
  }

  if (normalizedBase.endsWith("/v1beta/models")) {
    return withQuery(`${normalizedBase}/${model}:${action}`);
  }

  return trimmed;
}

function extractGeminiText(payload: unknown): string | null {
  if (payload === null || payload === undefined) {
    return null;
  }

  // 某些实现（或网关）可能返回 JSON 数组（如 streamGenerateContent 的非 SSE 形态）
  if (Array.isArray(payload)) {
    for (let i = payload.length - 1; i >= 0; i -= 1) {
      const extracted = extractGeminiText(payload[i]);
      if (extracted && extracted.trim()) {
        return extracted;
      }
    }
    return null;
  }

  const data = payload as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: unknown }> };
    }>;
  };

  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!parts || !Array.isArray(parts)) {
      continue;
    }

    const texts = parts
      .map((part) => {
        const value = part?.text;
        if (typeof value === "string") {
          return value;
        }
        if (typeof value === "number" || typeof value === "boolean") {
          return String(value);
        }
        return "";
      })
      .filter(Boolean);

    if (texts.length > 0) {
      const combined = texts.join("");
      if (combined.trim()) {
        return combined;
      }
    }
  }

  return null;
}

function mergeStreamText(previous: string | null, next: string): string {
  if (!previous) {
    return next;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next)) {
    return previous;
  }
  return previous + next;
}

function parseEventStreamLikeText(rawText: string): {
  text: string | null;
  lastPayload: unknown | null;
} {
  let lastPayload: unknown | null = null;
  let text: string | null = null;

  let eventDataLines: string[] = [];

  const handlePayload = (payload: string) => {
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      // 某些网关会发送 `null` 作为 keep-alive，占位符，跳过即可
      if (parsed === null) {
        return;
      }
      lastPayload = parsed;
      const extracted = extractGeminiText(parsed);
      if (extracted && extracted.trim()) {
        text = mergeStreamText(text, extracted);
      }
    } catch {
      // 忽略解析失败的 payload
    }
  };

  const flushEvent = () => {
    if (eventDataLines.length === 0) {
      return;
    }
    handlePayload(eventDataLines.join("\n"));
    eventDataLines = [];
  };

  const handleLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "") {
      flushEvent();
      return;
    }

    if (trimmed.startsWith("data:")) {
      eventDataLines.push(trimmed.slice("data:".length).trim());
      return;
    }

    // SSE 控制字段/注释
    if (
      trimmed.startsWith("event:") ||
      trimmed.startsWith("id:") ||
      trimmed.startsWith("retry:") ||
      trimmed.startsWith(":")
    ) {
      return;
    }

    // 兼容部分网关：content-type 不是 text/event-stream，但 body 仍是 NDJSON / SSE-like 行
    if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed === "null") {
      flushEvent();
      handlePayload(trimmed);
    }
  };

  for (const line of rawText.split(/\r?\n/)) {
    handleLine(line);
  }
  flushEvent();

  return { text, lastPayload };
}

async function readEventStreamText(response: Response): Promise<{
  text: string | null;
  lastPayload: unknown | null;
}> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Gemini 返回为空（无响应体）");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let lastPayload: unknown | null = null;
  let text: string | null = null;

  let eventDataLines: string[] = [];

  const handlePayload = (payload: string) => {
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      // 某些网关会发送 `null` 作为 keep-alive，占位符，跳过即可
      if (parsed === null) {
        return;
      }
      lastPayload = parsed;
      const extracted = extractGeminiText(parsed);
      if (extracted && extracted.trim()) {
        text = mergeStreamText(text, extracted);
      }
    } catch {
      // 忽略解析失败的 payload
    }
  };

  const flushEvent = () => {
    if (eventDataLines.length === 0) {
      return;
    }
    handlePayload(eventDataLines.join("\n"));
    eventDataLines = [];
  };

  const handleLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "") {
      flushEvent();
      return;
    }

    if (trimmed.startsWith("data:")) {
      eventDataLines.push(trimmed.slice("data:".length).trim());
      return;
    }

    // SSE 控制字段/注释
    if (
      trimmed.startsWith("event:") ||
      trimmed.startsWith("id:") ||
      trimmed.startsWith("retry:") ||
      trimmed.startsWith(":")
    ) {
      return;
    }

    // 兼容部分网关：虽然标记为 text/event-stream，但直接输出 NDJSON / JSON 行
    if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed === "null") {
      flushEvent();
      handlePayload(trimmed);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      handleLine(line);
    }
  }

  // 处理尾部残留
  for (const line of buffer.split(/\r?\n/)) {
    handleLine(line);
  }
  flushEvent();

  return { text, lastPayload };
}

export async function requestGeminiNative(params: {
  endpoint: string;
  apiKey: string;
  model: string;
  prompt: string;
  timeoutMs?: number;
  action?: GeminiAction;
  requestHeaders?: Record<string, string> | null;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  const action = params.action ?? "streamGenerateContent";
  const url = resolveGeminiUrlForAction(params.endpoint, params.model, action);
  const headers = new Headers({
    Authorization: `Bearer ${params.apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": "check-cx/0.1.0",
  });
  for (const [key, value] of Object.entries(params.requestHeaders ?? {})) {
    headers.set(key, value);
  }
  // 确保鉴权与内容类型不被覆盖
  headers.set("Authorization", `Bearer ${params.apiKey}`);
  headers.set("Content-Type", "application/json");
  headers.set(
    "Accept",
    action === "streamGenerateContent"
      ? "application/json, text/event-stream"
      : "application/json"
  );

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: params.prompt }],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 32,
    },
  };
  const requestBody = JSON.stringify(body);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: requestBody,
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw createGeminiApiError(response.status, text);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const { text, lastPayload } = await readEventStreamText(response);
      if (text && text.trim()) {
        return text;
      }
      // 200 但无有效输出：按“空回复”处理（避免 UI 显示为 error/[200] null）
      void lastPayload;
      return "";
    }

    const rawText = await response.text().catch(() => "");
    const trimmed = rawText.trim();
    if (!trimmed || trimmed === "null") {
      return "";
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawText) as unknown;
    } catch {
      const { text, lastPayload } = parseEventStreamLikeText(rawText);
      if (text && text.trim()) {
        return text;
      }
      payload = lastPayload;
    }

    const text = extractGeminiText(payload);
    return text?.trim() ? text : "";
  } finally {
    clearTimeout(timeout);
  }
}

function logCheckResult(
  config: ProviderConfig,
  prompt: string,
  response: string,
  expectedAnswer: string,
  isValid: boolean | null
): void {
  const validStatus = isValid === null ? "失败(空回复)" : isValid ? "通过" : "失败";
  const groupName = config.groupName || "默认";
  const normalizedPrompt = prompt.replace(/\r?\n/g, " ");
  console.log(
    `[${config.type}] ${groupName} | ${config.name} | Q: ${normalizedPrompt} | A: ${response || "(空)"} | 期望: ${expectedAnswer} | 验证: ${validStatus}`
  );
}

function buildCheckResult(params: {
  config: ProviderConfig;
  endpoint: string;
  pingLatencyMs: number | null;
}): (status: HealthStatus | "validation_failed" | "failed" | "error", latencyMs: number | null, message: string) => CheckResult {
  return (status, latencyMs, message) => ({
    id: params.config.id,
    name: params.config.name,
    type: params.config.type,
    endpoint: params.endpoint,
    model: params.config.model,
    status,
    latencyMs,
    pingLatencyMs: params.pingLatencyMs,
    checkedAt: new Date().toISOString(),
    message,
  });
}

export async function checkWithGeminiNative(
  config: ProviderConfig
): Promise<CheckResult> {
  const startedAt = Date.now();
  const displayEndpoint = config.endpoint?.trim() || DEFAULT_ENDPOINTS.gemini;
  const pingPromise = measureEndpointPing(displayEndpoint);

  const challenge = generateChallenge();

  try {
    let responseText = await requestGeminiNative({
      endpoint: displayEndpoint,
      apiKey: config.apiKey,
      model: config.model,
      prompt: challenge.prompt,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      action: "streamGenerateContent",
      requestHeaders: config.requestHeaders ?? undefined,
    });

    if (!responseText.trim()) {
      console.warn(
        `[gemini] ${config.name} streamGenerateContent 返回空，尝试 generateContent 重试`
      );
      responseText = await requestGeminiNative({
        endpoint: displayEndpoint,
        apiKey: config.apiKey,
        model: config.model,
        prompt: challenge.prompt,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        action: "generateContent",
        requestHeaders: config.requestHeaders ?? undefined,
      });
    }

    const latencyMs = Date.now() - startedAt;
    const pingLatencyMs = await pingPromise;
    const toResult = buildCheckResult({ config, endpoint: displayEndpoint, pingLatencyMs });

    if (!responseText.trim()) {
      logCheckResult(config, challenge.prompt, "", challenge.expectedAnswer, null);
      return toResult("failed", latencyMs, "回复为空");
    }

    const { valid, extractedNumbers } = validateResponse(
      responseText,
      challenge.expectedAnswer
    );
    logCheckResult(config, challenge.prompt, responseText, challenge.expectedAnswer, valid);

    if (!valid) {
      const actualNumbers = extractedNumbers?.join(", ") || "(无数字)";
      return toResult(
        "validation_failed",
        latencyMs,
        `回复验证失败: 期望 ${challenge.expectedAnswer}, 实际: ${actualNumbers}`
      );
    }

    const status: HealthStatus =
      latencyMs <= DEGRADED_THRESHOLD_MS ? "operational" : "degraded";
    const message =
      status === "degraded"
        ? `响应成功但耗时 ${latencyMs}ms`
        : `验证通过 (${latencyMs}ms)`;

    return toResult(status, latencyMs, message);
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const pingLatencyMs = await pingPromise;
    const toResult = buildCheckResult({ config, endpoint: displayEndpoint, pingLatencyMs });
    return toResult("error", latencyMs, getErrorMessage(error));
  }
}
