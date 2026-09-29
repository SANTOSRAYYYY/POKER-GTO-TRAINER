/**
 * 统一设置存储抽象（key-value）：
 *
 * - 原生壳（Capacitor App）：主存储走 @capacitor/preferences（SharedPreferences，
 *   比 WebView localStorage 更耐清理），localStorage 同步写一份作镜像备份；
 *   同步读走「启动预载的内存缓存」，缓存未命中/未预载时回退 localStorage 镜像。
 * - Web / SSR / vitest：直接读写 localStorage（保持现有行为，stub localStorage
 *   的测试不受影响）；SSR（无 window）一律安全 no-op。
 *
 * 同步/异步策略：
 * - 写入 setItem：同步部分（内存缓存 + localStorage 镜像）在调用当下完成，
 *   Preferences 持久化异步进行——因此既有同步调用点（getStoredLang 等）改成
 *   `void setItem(...)` 后语义不变。
 * - 同步读 getItemSync：Web 直读 localStorage；原生读预载缓存（启动时
 *   initSettingsStorage 把 Preferences 全量搬进内存），未命中回退 localStorage
 *   镜像（镜像与 Preferences 始终同值，见迁移与写入路径）。
 * - 异步读 getItem：原生读 Preferences 真值（设置页等需要权威值的场景用），
 *   Web 读 localStorage。
 *
 * 一次性迁移：原生首次启动把 localStorage 全部 pokergto_* 键搬进 Preferences
 * （Preferences 已有值不覆盖；localStorage 原值保留作镜像），完成标记存
 * Preferences（pokergto_settings_migrated），只跑一次。
 *
 * 测试注入：__setStorageTestHooks 可覆盖 native 判定与 Preferences 后端，
 * __resetSettingsStorageForTests 复位全部模块态（init 缓存/预载缓存/覆盖）。
 */
import { Preferences } from "@capacitor/preferences";
import { isNativeApp } from "@/lib/nativeApp";

/** 迁移完成标记键（存 Preferences） */
export const SETTINGS_MIGRATION_KEY = "pokergto_settings_migrated";
/** 本应用 localStorage/Preferences 键的统一前缀 */
export const SETTINGS_KEY_PREFIX = "pokergto_";

/** 可注入的 Preferences 后端（生产为 @capacitor/preferences 适配器，测试为内存假实现） */
export interface PreferencesLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

const capacitorBackend: PreferencesLike = {
  async get(key) {
    const { value } = await Preferences.get({ key });
    return value ?? null;
  },
  async set(key, value) {
    await Preferences.set({ key, value });
  },
  async remove(key) {
    await Preferences.remove({ key });
  },
  async keys() {
    const { keys } = await Preferences.keys();
    return keys;
  },
};

// ---------------------------------------------------------------------------
// 模块态（测试可注入/复位）
// ---------------------------------------------------------------------------

let nativeOverride: boolean | null = null;
let backendOverride: PreferencesLike | null = null;
/** 原生预载缓存：Preferences 全量 + 每次写入的同步更新 */
const preloadCache = new Map<string, string>();
let initPromise: Promise<void> | null = null;

function useNative(): boolean {
  if (nativeOverride !== null) return nativeOverride;
  return isNativeApp();
}

function backend(): PreferencesLike {
  return backendOverride ?? capacitorBackend;
}

// ---------------------------------------------------------------------------
// localStorage 镜像（防御：SSR/隐私模式/stub 不全时静默降级）
// ---------------------------------------------------------------------------

function mirrorGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function mirrorSet(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式/配额满：仅内存缓存，Preferences 仍会异步持久化
  }
}

function mirrorRemove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}

/** 枚举 localStorage 里全部 pokergto_* 键（标准 Storage API 优先，退化 Object.keys） */
function mirrorKeys(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const ls = window.localStorage;
    const out: string[] = [];
    if (typeof ls.length === "number" && typeof ls.key === "function") {
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (typeof k === "string" && k.startsWith(SETTINGS_KEY_PREFIX)) {
          out.push(k);
        }
      }
      return out;
    }
    // 非标准 localStorage（测试 stub 等）：枚举自身键名
    for (const k of Object.keys(ls)) {
      if (k.startsWith(SETTINGS_KEY_PREFIX)) out.push(k);
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 原生启动初始化（Web 直接 resolve，可安全重复调用——内部只跑一次）：
 * 1) 一次性迁移 localStorage → Preferences（不覆盖已有值，localStorage 保留镜像）；
 * 2) 把 Preferences 全部 pokergto_* 键预载进内存缓存，供 getItemSync 同步读。
 */
export function initSettingsStorage(): Promise<void> {
  if (!useNative()) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const be = backend();
    // ---- 一次性迁移 ----
    try {
      const migrated = await be.get(SETTINGS_MIGRATION_KEY);
      if (migrated !== "1") {
        for (const key of mirrorKeys()) {
          if (key === SETTINGS_MIGRATION_KEY) continue;
          const local = mirrorGet(key);
          if (local === null) continue;
          const existing = await be.get(key);
          if (existing === null) await be.set(key, local);
        }
        await be.set(SETTINGS_MIGRATION_KEY, "1");
      }
    } catch (err) {
      console.error("[settings] localStorage → Preferences 迁移失败:", err);
    }
    // ---- 预载（Preferences 为主；缺失键回退 localStorage 镜像并回填） ----
    try {
      const keys = (await be.keys()).filter((k) =>
        k.startsWith(SETTINGS_KEY_PREFIX),
      );
      for (const key of keys) {
        const v = await be.get(key);
        if (v !== null) preloadCache.set(key, v);
      }
    } catch (err) {
      console.error("[settings] Preferences 预载失败（回退 localStorage 镜像）:", err);
    }
    for (const key of mirrorKeys()) {
      if (preloadCache.has(key)) continue;
      const local = mirrorGet(key);
      if (local === null) continue;
      preloadCache.set(key, local);
      // 迁移失败等情形下 Preferences 缺这份值：顺手回填，保证主存储完整
      void be.set(key, local).catch(() => {});
    }
  })();
  return initPromise;
}

/**
 * 同步读：原生命中预载缓存用缓存，否则回退 localStorage 镜像；
 * Web/SSR 直读 localStorage（SSR 返回 null）。
 */
export function getItemSync(key: string): string | null {
  if (useNative() && preloadCache.has(key)) {
    return preloadCache.get(key) ?? null;
  }
  return mirrorGet(key);
}

/** 异步读：原生读 Preferences 真值（异常回退镜像），Web 读 localStorage */
export async function getItem(key: string): Promise<string | null> {
  if (!useNative()) return mirrorGet(key);
  try {
    const v = await backend().get(key);
    if (v !== null) {
      preloadCache.set(key, v);
      return v;
    }
    return mirrorGet(key);
  } catch {
    return mirrorGet(key);
  }
}

/**
 * 写：同步更新内存缓存 + localStorage 镜像（既有同步读者立即可见），
 * 原生再异步落 Preferences（await 可拿到持久化完成时机；void 调用即乐观写）。
 */
export async function setItem(key: string, value: string): Promise<void> {
  preloadCache.set(key, value);
  mirrorSet(key, value);
  if (!useNative()) return;
  try {
    await backend().set(key, value);
  } catch (err) {
    console.error("[settings] Preferences 写入失败（已保留 localStorage 镜像）:", err);
  }
}

/** 删：缓存 + 镜像 + Preferences 同步清理 */
export async function removeItem(key: string): Promise<void> {
  preloadCache.delete(key);
  mirrorRemove(key);
  if (!useNative()) return;
  try {
    await backend().remove(key);
  } catch {
    // 镜像已删，主存储删除失败仅留残余值
  }
}

// ---------------------------------------------------------------------------
// 测试钩子
// ---------------------------------------------------------------------------

/** 注入 native 判定与 Preferences 后端（传 null 恢复默认） */
export function __setStorageTestHooks(opts: {
  native?: boolean | null;
  backend?: PreferencesLike | null;
}): void {
  if (opts.native !== undefined) nativeOverride = opts.native;
  if (opts.backend !== undefined) backendOverride = opts.backend;
}

/** 复位全部模块态（init 单例、预载缓存、注入覆盖） */
export function __resetSettingsStorageForTests(): void {
  nativeOverride = null;
  backendOverride = null;
  preloadCache.clear();
  initPromise = null;
}
