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

/** 性能降级阈值（毫秒） */
const DEGRADED_THRESHOLD_MS = 6_000;

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

function resolveGeminiUrl(endpoint: string, model: string): string {
  const trimmed = endpoint.trim();

  if (trimmed.includes(":streamGenerateContent")) {
    return trimmed;
  }

  const [base, query = ""] = trimmed.split("?");
  const normalizedBase = base.replace(/\/+$/, "");

  if (normalizedBase.endsWith("/v1beta/models")) {
    const nextBase = `${normalizedBase}/${model}:streamGenerateContent`;
    return query ? `${nextBase}?${query}` : nextBase;
  }

  return trimmed;
}

function extractGeminiText(payload: unknown): string | null {
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
  requestHeaders?: Record<string, string> | null;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  const url = resolveGeminiUrl(params.endpoint, params.model);
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

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
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
      // 兼容 NDJSON / SSE-like 逐行 JSON（取最后一个可解析的 JSON）
      let last: unknown | null = null;
      for (const line of rawText.split(/\r?\n/)) {
        const current = line.trim();
        if (!current || current === "[DONE]") {
          continue;
        }
        const maybePayload = current.startsWith("data:")
          ? current.slice("data:".length).trim()
          : current;
        if (!maybePayload || maybePayload === "[DONE]" || maybePayload === "null") {
          continue;
        }
        try {
          last = JSON.parse(maybePayload) as unknown;
        } catch {
          // 忽略解析失败的行
        }
      }
      payload = last;
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
    const responseText = await requestGeminiNative({
      endpoint: displayEndpoint,
      apiKey: config.apiKey,
      model: config.model,
      prompt: challenge.prompt,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      requestHeaders: config.requestHeaders ?? undefined,
    });

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
