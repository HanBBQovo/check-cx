/**
 * 前端内存缓存模块
 *
 * 实现 SWR (Stale-While-Revalidate) 模式：
 * - 缓存有效：立即返回，不发请求
 * - 缓存过期：立即返回旧数据，后台刷新
 * - 无缓存：等待请求完成
 */

import type { DashboardData, AvailabilityPeriod } from "../types";

/** 缓存有效期默认值：2 分钟 */
const DEFAULT_CACHE_TTL_MS = 2 * 60 * 1000;

/** 缓存条目 */
interface CacheEntry {
  data: DashboardData;
  timestamp: number;
  etag?: string;
  ttlMs: number;
}

/** 缓存键生成 */
function getCacheKey(trendPeriod: AvailabilityPeriod): string {
  return `dashboard:${trendPeriod}`;
}

/** 缓存存储 */
const cache = new Map<string, CacheEntry>();

/** 正在进行的请求（防止重复请求） */
const pendingRequests = new Map<string, Promise<DashboardData | null>>();

/** 检查缓存是否过期 */
function isExpired(entry: CacheEntry): boolean {
  return Date.now() - entry.timestamp >= entry.ttlMs;
}

/** 获取缓存 */
export function getCache(trendPeriod: AvailabilityPeriod): CacheEntry | null {
  const key = getCacheKey(trendPeriod);
  const entry = cache.get(key);
  return entry ?? null;
}

/** 设置缓存 */
export function setCache(
  trendPeriod: AvailabilityPeriod,
  data: DashboardData,
  etag?: string
): void {
  const key = getCacheKey(trendPeriod);
  const ttlMs =
    Number.isFinite(data.pollIntervalMs) && data.pollIntervalMs > 0
      ? data.pollIntervalMs
      : DEFAULT_CACHE_TTL_MS;
  cache.set(key, {
    data,
    timestamp: Date.now(),
    etag,
    ttlMs,
  });
}

/** 更新缓存时间戳（用于 304 响应） */
export function touchCache(trendPeriod: AvailabilityPeriod): void {
  const key = getCacheKey(trendPeriod);
  const entry = cache.get(key);
  if (entry) {
    entry.timestamp = Date.now();
  }
}

/** 清除所有缓存 */
export function clearCache(): void {
  cache.clear();
}

/**
 * 发起网络请求获取数据
 * @param trendPeriod 趋势周期
 * @param etag 缓存的 ETag（用于条件请求）
 * @param forceFresh 强制刷新（绕过 CDN）
 * @returns 数据或 null（304 时返回 null）
 */
async function fetchFromNetwork(
  trendPeriod: AvailabilityPeriod,
  etag?: string,
  forceFresh?: boolean
): Promise<{ data: DashboardData | null; etag?: string }> {
  const params = new URLSearchParams({ trendPeriod });
  if (forceFresh) {
    params.set("forceRefresh", "1");
    params.set("_t", String(Date.now()));
  }

  const headers: HeadersInit = {};
  if (etag) {
    headers["If-None-Match"] = etag;
  }

  const response = await fetch(`/api/dashboard?${params.toString()}`, {
    headers,
  });

  // 304 Not Modified - 数据未变
  if (response.status === 304) {
    return { data: null, etag };
  }

  if (!response.ok) {
    throw new Error(`请求失败: ${response.status}`);
  }

  const data = (await response.json()) as DashboardData;
  const newEtag = response.headers.get("ETag") ?? undefined;

  return { data, etag: newEtag };
}

/**
 * 后台刷新（不阻塞 UI）
 */
function revalidateInBackground(
  trendPeriod: AvailabilityPeriod,
  etag?: string,
  onUpdate?: (data: DashboardData) => void
): void {
  const key = getCacheKey(trendPeriod);

  // 如果已有请求在进行，不重复发起
  if (pendingRequests.has(key)) {
    return;
  }

  const request = fetchFromNetwork(trendPeriod, etag)
    .then(({ data, etag: newEtag }) => {
      if (data) {
        setCache(trendPeriod, data, newEtag);
        onUpdate?.(data);
        return data;
      } else {
        // 304 响应，更新时间戳
        touchCache(trendPeriod);
        return null;
      }
    })
    .catch((error) => {
      console.error("[check-cx] 后台刷新失败", error);
      return null;
    })
    .finally(() => {
      pendingRequests.delete(key);
    });

  pendingRequests.set(key, request);
}

export interface FetchWithCacheOptions {
  trendPeriod: AvailabilityPeriod;
  forceFresh?: boolean;
  onBackgroundUpdate?: (data: DashboardData) => void;
  revalidateIfFresh?: boolean;
}

export interface FetchWithCacheResult {
  data: DashboardData;
  fromCache: boolean;
  isRevalidating: boolean;
}

/**
 * 带缓存的数据获取（SWR 模式）
 *
 * 1. 缓存有效（< 2分钟）：直接返回，不发请求
 * 2. 缓存过期但存在：返回旧数据，后台刷新
 * 3. 无缓存：等待请求完成
 */
export async function fetchWithCache(
  options: FetchWithCacheOptions
): Promise<FetchWithCacheResult> {
  const { trendPeriod, forceFresh, onBackgroundUpdate, revalidateIfFresh } = options;
  const cached = getCache(trendPeriod);

  // 强制刷新：忽略缓存
  if (forceFresh) {
    const { data, etag } = await fetchFromNetwork(trendPeriod, undefined, true);
    if (data) {
      setCache(trendPeriod, data, etag);
      return { data, fromCache: false, isRevalidating: false };
    }
    // 理论上强制刷新不应该返回 304，但做兜底
    if (cached) {
      return { data: cached.data, fromCache: true, isRevalidating: false };
    }
    throw new Error("无数据可用");
  }

  // 缓存有效：直接返回
  if (cached && !isExpired(cached)) {
    if (revalidateIfFresh) {
      revalidateInBackground(trendPeriod, cached.etag, onBackgroundUpdate);
      return { data: cached.data, fromCache: true, isRevalidating: true };
    }
    return { data: cached.data, fromCache: true, isRevalidating: false };
  }

  // 缓存过期但存在：返回旧数据，后台刷新
  if (cached) {
    revalidateInBackground(trendPeriod, cached.etag, onBackgroundUpdate);
    return { data: cached.data, fromCache: true, isRevalidating: true };
  }

  // 无缓存：等待请求
  const { data, etag } = await fetchFromNetwork(trendPeriod);
  if (data) {
    setCache(trendPeriod, data, etag);
    return { data, fromCache: false, isRevalidating: false };
  }

  throw new Error("无数据可用");
}
