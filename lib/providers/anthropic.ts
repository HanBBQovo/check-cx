/**
 * Anthropic Provider 健康检查（使用官方 @anthropic-ai/sdk）
 */

import Anthropic from "@anthropic-ai/sdk";

import type { CheckResult, HealthStatus, ProviderConfig } from "../types";
import { DEFAULT_ENDPOINTS } from "../types";

/**
 * 默认超时时间 (毫秒)
 * 与其他 Provider 保持一致
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 性能降级阈值 (毫秒)
 * 与其他 Provider 保持一致
 */
const DEGRADED_THRESHOLD_MS = 6_000;

/**
 * 扩展 globalThis 以在 dev 热更时复用 Anthropic 客户端
 */
declare global {
  var __CHECK_CX_ANTHROPIC_CLIENTS__:
    | Map<string, Anthropic>
    | undefined;
}

/**
 * Anthropic 客户端全局缓存
 * key = baseURL + apiKey，用于复用连接和内部缓存
 */
const anthropicClientCache: Map<string, Anthropic> =
  globalThis.__CHECK_CX_ANTHROPIC_CLIENTS__ ??
  (globalThis.__CHECK_CX_ANTHROPIC_CLIENTS__ =
    new Map<string, Anthropic>());

/**
 * 从配置的 endpoint 推导 Anthropic SDK 的 baseURL
 *
 * - 支持默认的 https://api.anthropic.com/v1/messages
 * - 支持自定义 /v1/messages 路径
 * - 若使用第三方代理（例如 Liona、ZenMux 等），可直接将其作为 baseURL
 */
function deriveAnthropicBaseURL(
  endpoint: string | null | undefined
): string {
  const raw = endpoint || DEFAULT_ENDPOINTS.anthropic;

  // 去掉查询参数
  const [withoutQuery] = raw.split("?");
  let base = withoutQuery;

  // 去掉 /v1/messages 这类具体路径，保留前缀
  const messagesIndex = base.indexOf("/v1/messages");
  if (messagesIndex !== -1) {
    base = base.slice(0, messagesIndex);
  }

  // 对于官方域名，若未显式包含 /v1，则补上
  if (base.includes("api.anthropic.com") && !base.includes("/v1")) {
    base = `${base.replace(/\/$/, "")}/v1`;
  }

  return base;
}

/**
 * 获取（或创建）复用的 Anthropic 客户端
 */
function getAnthropicClient(config: ProviderConfig): Anthropic {
  const baseURL = deriveAnthropicBaseURL(config.endpoint);
  const cacheKey = `${baseURL}::${config.apiKey}`;

  const cached = anthropicClientCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL,
    // 某些代理/网关（例如启用了 Cloudflare「封锁 AI 爬虫」规则的站点）
    // 会对默认的 Anthropic User-Agent（如 `anthropic-ts-sdk/...`）返回 402 Your request was blocked.
    // 这里统一改成一个普通应用的 UA，避免被误判为爬虫。
    defaultHeaders: {
      "User-Agent": "check-cx/0.1.0",
    },
  });

  anthropicClientCache.set(cacheKey, client);
  return client;
}

/**
 * 检查 Anthropic API 健康状态（流式）
 */
export async function checkAnthropic(
  config: ProviderConfig
): Promise<CheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  const displayEndpoint = config.endpoint || DEFAULT_ENDPOINTS.anthropic;

  try {
    const client = getAnthropicClient(config);

    // 使用 Messages 流式接口进行最小请求
    const stream = await client.messages.create(
      {
        model: config.model,
        max_tokens: 1, // 仅需 1 个 token 即可确认服务可用
        messages: [{ role: "user", content: "hi" }], // 最简短的消息
        stream: true, // 启用流式响应
      },
      { signal: controller.signal }
    );

    // 读取完整的流式响应（内容本身不重要，只要能成功流式返回即可）
    // 只需确保至少收到一个事件即可证明流可用
    // 若长时间无事件，外层 AbortController 会触发超时
    const iterator = stream[Symbol.asyncIterator]();
    const { done } = await iterator.next();
    if (!done) {
      // 主动结束流，避免无意义的长时间占用
      if (typeof (iterator as AsyncIterator<unknown> & { return?: () => void })
        .return === "function") {
        await (
          iterator as AsyncIterator<unknown> & { return?: () => void }
        ).return?.();
      }
    }

    const latencyMs = Date.now() - startedAt;
    const status: HealthStatus =
      latencyMs <= DEGRADED_THRESHOLD_MS ? "operational" : "degraded";

    const message =
      status === "degraded"
        ? `响应成功但耗时 ${latencyMs}ms`
        : `流式响应正常 (${latencyMs}ms)`;

    return {
      id: config.id,
      name: config.name,
      type: config.type,
      endpoint: displayEndpoint,
      model: config.model,
      status,
      latencyMs,
      checkedAt: new Date().toISOString(),
      message,
    };
  } catch (error) {
    const err = error as Error & { name?: string };
    const message =
      err?.name === "AbortError" ? "请求超时" : err?.message || "未知错误";

    return {
      id: config.id,
      name: config.name,
      type: config.type,
      endpoint: displayEndpoint,
      model: config.model,
      status: "failed",
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
