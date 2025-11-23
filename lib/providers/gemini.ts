/**
 * Gemini Provider 健康检查（使用 OpenAI 兼容接口）
 *
 * Gemini 原生 SDK 不支持自定义 baseURL，但可以使用 OpenAI 兼容的请求方式
 */

import OpenAI from "openai";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";

import type { CheckResult, HealthStatus, ProviderConfig } from "../types";
import { DEFAULT_ENDPOINTS } from "../types";
import { measureEndpointPing } from "./endpoint-ping";

/**
 * 默认超时时间 (毫秒)
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 性能降级阈值 (毫秒)
 */
const DEGRADED_THRESHOLD_MS = 6_000;

/**
 * 扩展 globalThis 以在 dev 热更时复用 OpenAI 客户端
 */
declare global {
  var __CHECK_CX_GEMINI_CLIENTS__:
    | Map<string, OpenAI>
    | undefined;
}

/**
 * Gemini 客户端全局缓存
 * key = baseURL + apiKey，用于复用连接和内部缓存
 */
const geminiClientCache: Map<string, OpenAI> =
  globalThis.__CHECK_CX_GEMINI_CLIENTS__ ??
  (globalThis.__CHECK_CX_GEMINI_CLIENTS__ = new Map<string, OpenAI>());

/**
 * 从配置的 endpoint 推导 baseURL
 *
 * 支持 OpenAI 兼容的路径格式：
 * - /v1/chat/completions
 * - /chat/completions
 */
function deriveGeminiBaseURL(endpoint: string | null | undefined): string {
  const raw = endpoint || DEFAULT_ENDPOINTS.gemini;

  // 去掉查询参数
  const [withoutQuery] = raw.split("?");
  let base = withoutQuery;

  // 去掉 /chat/completions 这类具体路径，保留前缀
  const chatIndex = base.indexOf("/chat/completions");
  if (chatIndex !== -1) {
    base = base.slice(0, chatIndex);
  }

  // 确保以 /v1 结尾（如果原路径包含 /v1）
  const v1Index = base.indexOf("/v1");
  if (v1Index !== -1) {
    base = base.slice(0, v1Index + "/v1".length);
  }

  return base;
}

/**
 * 获取（或创建）复用的 OpenAI 客户端
 */
function getGeminiClient(config: ProviderConfig): OpenAI {
  const baseURL = deriveGeminiBaseURL(config.endpoint);
  const cacheKey = `${baseURL}::${config.apiKey}`;

  const cached = geminiClientCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL,
    defaultHeaders: {
      "User-Agent": "check-cx/0.1.0",
    },
  });

  geminiClientCache.set(cacheKey, client);
  return client;
}

/**
 * 检查 Gemini API 健康状态（使用 OpenAI 兼容接口）
 */
export async function checkGemini(
  config: ProviderConfig
): Promise<CheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  const displayEndpoint = config.endpoint || DEFAULT_ENDPOINTS.gemini;
  const pingPromise = measureEndpointPing(displayEndpoint);

  try {
    const client = getGeminiClient(config);

    // 使用 OpenAI 兼容的 Chat Completions 流式接口
    const requestPayload: ChatCompletionCreateParamsStreaming = {
      model: config.model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      temperature: 0,
      stream: true,
    };

    const stream = await client.chat.completions.create(requestPayload, {
      signal: controller.signal,
    });

    // 读取流式响应
    for await (const chunk of stream) {
      // 仅保证流可读，不需要组装完整内容
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      chunk.choices?.[0]?.delta?.content;
    }

    const latencyMs = Date.now() - startedAt;
    const status: HealthStatus =
      latencyMs <= DEGRADED_THRESHOLD_MS ? "operational" : "degraded";

    const message =
      status === "degraded"
        ? `响应成功但耗时 ${latencyMs}ms`
        : `流式响应正常 (${latencyMs}ms)`;

    const pingLatencyMs = await pingPromise;
    return {
      id: config.id,
      name: config.name,
      type: config.type,
      endpoint: displayEndpoint,
      model: config.model,
      status,
      latencyMs,
      pingLatencyMs,
      checkedAt: new Date().toISOString(),
      message,
    };
  } catch (error) {
    const err = error as Error & { name?: string };
    const message =
      err?.name === "AbortError" ? "请求超时" : err?.message || "未知错误";

    const pingLatencyMs = await pingPromise;
    return {
      id: config.id,
      name: config.name,
      type: config.type,
      endpoint: displayEndpoint,
      model: config.model,
      status: "failed",
      latencyMs: null,
      pingLatencyMs,
      checkedAt: new Date().toISOString(),
      message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
