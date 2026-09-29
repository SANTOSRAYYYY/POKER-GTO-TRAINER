/**
 * 统一设置存储（lib/storage/settings.ts）测试：
 *
 * - Web/非原生路径：所有读写直落 localStorage（与既有 stub localStorage 的
 *   测试同一前提），setItem 的镜像更新同步可见；
 * - 原生路径（注入假 Preferences 后端）：首次 init 把 localStorage 的
 *   pokergto_* 键一次性搬入 Preferences（已有值不覆盖、localStorage 保留镜像、
 *   标记只跑一次），预载后 getItemSync 以 Preferences 为准；
 * - setItem 在原生下同步更新内存缓存（未 init 也能同步读到），并双写
 *   Preferences + localStorage 镜像。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetSettingsStorageForTests,
  __setStorageTestHooks,
  getItem,
  getItemSync,
  initSettingsStorage,
  removeItem,
  setItem,
  SETTINGS_MIGRATION_KEY,
  type PreferencesLike,
} from "@/lib/storage/settings";

// ---------------------------------------------------------------------------
// 存根
// ---------------------------------------------------------------------------

function makeLocalStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, String(v));
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
  };
  return { data, ls };
}

function makeBackend(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const backend: PreferencesLike = {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      data.set(k, v);
    },
    remove: async (k) => {
      data.delete(k);
    },
    keys: async () => [...data.keys()],
  };
  return { data, backend };
}

function stubWindow(ls: unknown): void {
  vi.stubGlobal("window", { localStorage: ls });
}

afterEach(() => {
  __resetSettingsStorageForTests();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 非原生（Web / 现有测试同路径）
// ---------------------------------------------------------------------------

describe("非原生路径（直读 localStorage）", () => {
  it("getItemSync/setItem/getItem/removeItem 直落 localStorage", async () => {
    const { data, ls } = makeLocalStorage({ pokergto_lang: "en" });
    stubWindow(ls);

    expect(getItemSync("pokergto_lang")).toBe("en");
    expect(getItemSync("pokergto_missing")).toBeNull();

    await setItem("pokergto_sound", "0");
    expect(data.get("pokergto_sound")).toBe("0");
    expect(getItemSync("pokergto_sound")).toBe("0");
    await expect(getItem("pokergto_sound")).resolves.toBe("0");

    await removeItem("pokergto_sound");
    expect(getItemSync("pokergto_sound")).toBeNull();
    expect(data.has("pokergto_sound")).toBe(false);
  });

  it("setItem 不 await 也同步可见（乐观写：镜像 + 缓存同步更新）", () => {
    const { ls } = makeLocalStorage();
    stubWindow(ls);
    void setItem("pokergto_ai_engine", "llm");
    expect(getItemSync("pokergto_ai_engine")).toBe("llm");
  });

  it("SSR（无 window）全部安全降级", async () => {
    expect(getItemSync("pokergto_lang")).toBeNull();
    await expect(getItem("pokergto_lang")).resolves.toBeNull();
    await expect(setItem("pokergto_lang", "en")).resolves.toBeUndefined();
    await expect(removeItem("pokergto_lang")).resolves.toBeUndefined();
    await expect(initSettingsStorage()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 原生路径（注入假 Preferences 后端）
// ---------------------------------------------------------------------------

describe("原生路径（Preferences 主存储 + localStorage 镜像）", () => {
  it("首次 init 迁移：localStorage → Preferences（已有值不覆盖），镜像保留，标记落盘", async () => {
    const { data: lsData, ls } = makeLocalStorage({
      pokergto_lang: "en",
      pokergto_sound: "0",
      pokergto_llm_config: '{"apiKey":"sk"}',
      other_app_key: "不要搬",
    });
    stubWindow(ls);
    const { data: beData, backend } = makeBackend({
      pokergto_lang: "zh", // Preferences 已有值：迁移不得覆盖
    });
    __setStorageTestHooks({ native: true, backend });

    await initSettingsStorage();

    // 搬入缺失键，保留已有键
    expect(beData.get("pokergto_lang")).toBe("zh");
    expect(beData.get("pokergto_sound")).toBe("0");
    expect(beData.get("pokergto_llm_config")).toBe('{"apiKey":"sk"}');
    expect(beData.get(SETTINGS_MIGRATION_KEY)).toBe("1");
    // 非本应用前缀不搬
    expect(beData.has("other_app_key")).toBe(false);
    // localStorage 原值保留作镜像备份
    expect(lsData.get("pokergto_lang")).toBe("en");
    expect(lsData.get("pokergto_sound")).toBe("0");
    // 预载后同步读以 Preferences 为准（不是 localStorage 镜像里的旧值）
    expect(getItemSync("pokergto_lang")).toBe("zh");
    expect(getItemSync("pokergto_sound")).toBe("0");
  });

  it("迁移只跑一次：再次启动（标记已落盘）不重复搬运", async () => {
    const { data: beData, backend } = makeBackend({
      [SETTINGS_MIGRATION_KEY]: "1",
      pokergto_sound: "0",
    });
    const { ls } = makeLocalStorage({ pokergto_sound: "1" });
    stubWindow(ls);
    __setStorageTestHooks({ native: true, backend });

    await initSettingsStorage();
    // 标记已存在：localStorage 的新值不再覆盖 Preferences
    expect(beData.get("pokergto_sound")).toBe("0");
  });

  it("init 幂等：重复调用共享同一初始化", async () => {
    const { ls } = makeLocalStorage({ pokergto_sound: "0" });
    stubWindow(ls);
    const { backend } = makeBackend();
    __setStorageTestHooks({ native: true, backend });
    const p1 = initSettingsStorage();
    const p2 = initSettingsStorage();
    expect(p1).toBe(p2);
    await p1;
  });

  it("原生 setItem 双写 Preferences + 镜像，且未 init 时同步读立即可见", async () => {
    const { data: lsData, ls } = makeLocalStorage();
    stubWindow(ls);
    const { data: beData, backend } = makeBackend();
    __setStorageTestHooks({ native: true, backend });

    // 故意不 init：缓存同步更新保证 getItemSync 仍读到新值
    void setItem("pokergto_ai_engine", "llm");
    expect(getItemSync("pokergto_ai_engine")).toBe("llm");

    await setItem("pokergto_default_style", "tag");
    expect(beData.get("pokergto_default_style")).toBe("tag");
    expect(lsData.get("pokergto_default_style")).toBe("tag"); // 镜像
  });

  it("getItem（异步）：Preferences 缺键时回退 localStorage 镜像", async () => {
    const { ls } = makeLocalStorage({ pokergto_panel_collapsed: "1" });
    stubWindow(ls);
    const { backend } = makeBackend();
    __setStorageTestHooks({ native: true, backend });

    await expect(getItem("pokergto_panel_collapsed")).resolves.toBe("1");
  });

  it("原生 removeItem 三处同步清理", async () => {
    const { data: lsData, ls } = makeLocalStorage({ pokergto_sound: "0" });
    stubWindow(ls);
    const { data: beData, backend } = makeBackend({ pokergto_sound: "0" });
    __setStorageTestHooks({ native: true, backend });
    await initSettingsStorage();

    await removeItem("pokergto_sound");
    expect(getItemSync("pokergto_sound")).toBeNull();
    expect(lsData.has("pokergto_sound")).toBe(false);
    expect(beData.has("pokergto_sound")).toBe(false);
  });
});
