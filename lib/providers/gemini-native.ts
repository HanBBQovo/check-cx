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
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!parts || !Array.isArray(parts)) {
    return null;
  }

  const texts = parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean);

  return texts.length > 0 ? texts.join("") : null;
}

async function readEventStreamJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Gemini 返回为空（无响应体）");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let lastJson: unknown = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const payload = trimmed.slice("data:".length).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }
      try {
        lastJson = JSON.parse(payload);
      } catch {
        // 忽略解析失败的行
      }
    }
  }

  // 处理尾部残留
  for (const line of buffer.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      lastJson = JSON.parse(payload);
    } catch {
      // ignore
    }
  }

  if (lastJson === null) {
    const text = await response.text().catch(() => "");
    throw createGeminiApiError(
      response.status || 500,
      text,
      "Gemini 流式响应未包含可解析的 data: JSON"
    );
  }

  return lastJson;
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
    const payload =
      contentType.includes("text/event-stream")
        ? await readEventStreamJson(response)
        : await response.json();

    const text = extractGeminiText(payload);
    if (!text || !text.trim()) {
      throw createGeminiApiError(
        response.status || 500,
        JSON.stringify(payload).slice(0, 1000),
        "Gemini 响应中未找到 candidates 文本"
      );
    }

    return text;
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
    const pingLatencyMs = await pingPromise;
    const toResult = buildCheckResult({ config, endpoint: displayEndpoint, pingLatencyMs });
    return toResult("error", null, getErrorMessage(error));
  }
}

