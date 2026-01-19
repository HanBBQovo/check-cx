/**
 * 全局状态管理
 * 统一管理轮询器状态和缓存
 */

import type {PingCacheEntry} from "../types";

export type PollerRole = "leader" | "standby";

/**
 * 扩展 globalThis 类型
 */
declare global {
  var __checkCxPoller: NodeJS.Timeout | undefined;
  var __checkCxPollerRunning: boolean | undefined;
  var __checkCxLastPingStartedAt: number | undefined;
  var __checkCxPollerLeaderTimer: NodeJS.Timeout | undefined;
  var __checkCxPollerRole: PollerRole | undefined;
  var __CHECK_CX_PING_CACHE__: Record<string, PingCacheEntry> | undefined;
}

/**
 * 获取轮询器定时器
 */
export function getPollerTimer(): NodeJS.Timeout | undefined {
  return globalThis.__checkCxPoller;
}

/**
 * 设置轮询器定时器
 */
export function setPollerTimer(timer: NodeJS.Timeout): void {
  globalThis.__checkCxPoller = timer;
}

/**
 * 获取主节点选举定时器
 */
export function getPollerLeaderTimer(): NodeJS.Timeout | undefined {
  return globalThis.__checkCxPollerLeaderTimer;
}

/**
 * 设置主节点选举定时器
 */
export function setPollerLeaderTimer(timer: NodeJS.Timeout): void {
  globalThis.__checkCxPollerLeaderTimer = timer;
}

/**
 * 获取当前节点角色
 */
export function getPollerRole(): PollerRole {
  return globalThis.__checkCxPollerRole ?? "standby";
}

/**
 * 设置当前节点角色
 */
export function setPollerRole(role: PollerRole): void {
  globalThis.__checkCxPollerRole = role;
}

/**
 * 获取轮询器运行状态
 */
export function isPollerRunning(): boolean {
  return globalThis.__checkCxPollerRunning ?? false;
}

/**
 * 设置轮询器运行状态
 */
export function setPollerRunning(running: boolean): void {
  globalThis.__checkCxPollerRunning = running;
}

/**
 * 获取最后一次 Ping 开始时间
 */
export function getLastPingStartedAt(): number | undefined {
  return globalThis.__checkCxLastPingStartedAt;
}

/**
 * 设置最后一次 Ping 开始时间
 */
export function setLastPingStartedAt(timestamp: number): void {
  globalThis.__checkCxLastPingStartedAt = timestamp;
}

/**
 * 缓存配置
 */
const PING_CACHE_MAX_SIZE = 10;
const PING_CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟

/**
 * 获取 Ping 缓存存储
 */
export function getPingCacheStore(): Record<string, PingCacheEntry> {
  if (!globalThis.__CHECK_CX_PING_CACHE__) {
    globalThis.__CHECK_CX_PING_CACHE__ = {};
  }
  return globalThis.__CHECK_CX_PING_CACHE__;
}

/**
 * 清理过期或超量的缓存条目
 */
function pruneCache(store: Record<string, PingCacheEntry>): void {
  const keys = Object.keys(store);
  const now = Date.now();

  // 清理过期条目
  for (const key of keys) {
    const entry = store[key];
    if (now - entry.lastPingAt > PING_CACHE_TTL_MS) {
      delete store[key];
    }
  }

  // 如果仍超过最大数量，删除最旧的条目
  const remainingKeys = Object.keys(store);
  if (remainingKeys.length > PING_CACHE_MAX_SIZE) {
    const sorted = remainingKeys.sort(
      (a, b) => store[a].lastPingAt - store[b].lastPingAt
    );
    const toRemove = sorted.slice(0, remainingKeys.length - PING_CACHE_MAX_SIZE);
    for (const key of toRemove) {
      delete store[key];
    }
  }
}

/**
 * 获取指定缓存键的 Ping 缓存条目
 */
export function getPingCacheEntry(key: string): PingCacheEntry {
  const store = getPingCacheStore();

  // 每次获取时进行清理
  pruneCache(store);

  if (!store[key]) {
    store[key] = { lastPingAt: 0 };
  }
  return store[key];
}

/**
 * 清除所有 Ping 缓存
 */
export function clearPingCache(): void {
  globalThis.__CHECK_CX_PING_CACHE__ = {};
}
