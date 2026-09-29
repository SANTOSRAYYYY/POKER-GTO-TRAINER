/**
 * historyStore 持久化层测试（审计 E1/E2/E3/E4 修复）
 *
 * - 读入侧校验：缺 players/streets/finalBoard 的损坏记录被跳过 + console.warn，
 *   不再拖垮 loadAll/listHands/getHand（E4）；
 * - loadAll 失败（IndexedDB 不可用/openDB 拒绝）进入 loaded:true + loadError
 *   错误终态而非永久「加载中」（E1）；
 * - openDB 失败的 promise 不缓存，下次调用重试（E2）；
 * - saveHand 先更新内存再异步落库，落库失败 console.error 且内存数据保留（E3）。
 *
 * 方案：vi.mock("idb") 注入可控假 DB；vi.resetModules + 动态 import 让每个
 * 用例拿到全新的 store 单例与 dbPromise 缓存。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandRecord } from "@/lib/types";

// ---------------------------------------------------------------------------
// 可控假 IndexedDB
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FakeTables {
  hands: unknown[];
  analyses: unknown[];
}

function makeDb(seed: Partial<FakeTables> = {}, opts: { failPuts?: boolean } = {}) {
  const tables: FakeTables = {
    hands: [...(seed.hands ?? [])],
    analyses: [...(seed.analyses ?? [])],
  };
  const keyOf = (store: keyof FakeTables) => (store === "hands" ? "id" : "handId");
  const db = {
    getAll: async (store: keyof FakeTables) => [...tables[store]],
    get: async (store: keyof FakeTables, id: string) =>
      tables[store].find((r) => (r as Row)[keyOf(store)] === id),
    put: async (store: keyof FakeTables, val: unknown) => {
      if (opts.failPuts) throw new Error("QuotaExceededError: 存储配额已满");
      const key = keyOf(store);
      const rec = val as Row;
      const idx = tables[store].findIndex((r) => (r as Row)[key] === rec[key]);
      if (idx >= 0) tables[store][idx] = val;
      else tables[store].push(val);
    },
    delete: async (store: keyof FakeTables, id: string) => {
      const key = keyOf(store);
      tables[store] = tables[store].filter((r) => (r as Row)[key] !== id);
    },
    clear: async (store: keyof FakeTables) => {
      tables[store] = [];
    },
  };
  return { db, tables };
}

let openDBCalls = 0;
let openDBImpl: () => Promise<unknown> = () => Promise.reject(new Error("未配置"));

vi.mock("idb", () => ({
  openDB: () => {
    openDBCalls += 1;
    return openDBImpl();
  },
}));

/** 全新模块（新 store 单例 + 新 dbPromise 缓存） */
async function freshStore() {
  vi.resetModules();
  return import("@/lib/store/historyStore");
}

beforeEach(() => {
  openDBCalls = 0;
  vi.stubGlobal("indexedDB", {}); // node 环境无 indexedDB，补占位让 getDB 走 openDB 分支
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function mkHand(id: string, timestamp = 0): HandRecord {
  return {
    id,
    timestamp,
    players: [
      { seat: 0, isHero: true, aiStyle: null, cards: ["As", "Kh"], profit: 10 },
      { seat: 1, isHero: false, aiStyle: "tag", cards: null, profit: -10 },
    ],
    heroSeat: 0,
    buttonSeat: 0,
    smallBlind: 50,
    bigBlind: 100,
    ante: 0,
    streets: [],
    finalBoard: [],
    result: "win",
    profit: 10,
    showdown: true,
  };
}

// ---------------------------------------------------------------------------
// E4：读入侧校验
// ---------------------------------------------------------------------------

describe("isValidHandRecord 读入侧校验", () => {
  it("合法记录通过；缺 players/streets/finalBoard 或形状非法被拒", async () => {
    const { isValidHandRecord } = await freshStore();
    expect(isValidHandRecord(mkHand("ok"))).toBe(true);
    expect(isValidHandRecord(null)).toBe(false);
    expect(isValidHandRecord(undefined)).toBe(false);
    expect(isValidHandRecord("hand")).toBe(false);
    expect(isValidHandRecord({ id: "x", streets: [], finalBoard: [] })).toBe(false);
    expect(isValidHandRecord({ ...mkHand("a"), players: undefined })).toBe(false);
    expect(isValidHandRecord({ ...mkHand("b"), players: "nope" })).toBe(false);
    expect(isValidHandRecord({ ...mkHand("c"), streets: null })).toBe(false);
    expect(isValidHandRecord({ ...mkHand("d"), streets: {} })).toBe(false);
    expect(isValidHandRecord({ ...mkHand("e"), finalBoard: "AhKhQh" })).toBe(false);
  });

  it("loadAll：6 条记录混入 1 条坏记录，其余 5 条正常加载并 warn 一次", async () => {
    const good = [
      mkHand("g1", 100),
      mkHand("g2", 500),
      mkHand("g3", 300),
      mkHand("g4", 200),
      mkHand("g5", 400),
    ];
    const corrupt = { id: "bad1", timestamp: 600 }; // 缺 players/streets/finalBoard
    const { db } = makeDb({ hands: [...good, corrupt] });
    openDBImpl = () => Promise.resolve(db);

    const { useHistoryStore } = await freshStore();
    await useHistoryStore.getState().loadAll();

    const s = useHistoryStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.loadError).toBeNull();
    expect(s.hands).toHaveLength(5);
    // 时间倒序（坏记录时间戳最大，若未过滤会排在最前）
    expect(s.hands.map((h) => h.id)).toEqual(["g2", "g5", "g3", "g4", "g1"]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0][1]).toBe("bad1");
  });

  it("listHands：坏记录跳过，合法记录照常做跑马街回填", async () => {
    const runoutHand: HandRecord = {
      ...mkHand("runout", 1000),
      streets: [
        {
          street: "preflop",
          board: [],
          actions: [{ seat: 0, action: { type: "allin", amount: 100 } }],
        },
      ],
      finalBoard: ["Qh", "7d", "2c", "5s", "9h"],
    };
    const corrupt = { id: "bad2", timestamp: 2000, players: null };
    const { db } = makeDb({ hands: [runoutHand, corrupt] });
    openDBImpl = () => Promise.resolve(db);

    const { useHistoryStore } = await freshStore();
    const hands = await useHistoryStore.getState().listHands();

    expect(hands).toHaveLength(1);
    expect(hands[0].id).toBe("runout");
    // withRunoutStreets 幂等回填：flop/turn/river 空动作街补齐
    expect(hands[0].streets.map((st) => st.street)).toEqual([
      "preflop",
      "flop",
      "turn",
      "river",
    ]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("getHand：坏记录返回 null 并 warn，不抛异常；合法记录正常返回", async () => {
    const corrupt = { id: "bad3", timestamp: 1, streets: [] }; // 缺 players/finalBoard
    const { db } = makeDb({ hands: [mkHand("good", 1), corrupt] });
    openDBImpl = () => Promise.resolve(db);

    const { useHistoryStore } = await freshStore();
    await expect(useHistoryStore.getState().getHand("bad3")).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
    await expect(useHistoryStore.getState().getHand("good")).resolves.toMatchObject({
      id: "good",
    });
    await expect(useHistoryStore.getState().getHand("missing")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E1：IndexedDB 不可用时的错误终态
// ---------------------------------------------------------------------------

describe("loadAll 错误终态（E1）", () => {
  it("环境无 IndexedDB：loaded:true + loadError 文案，不抛异常", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const { useHistoryStore } = await freshStore();
    await expect(useHistoryStore.getState().loadAll()).resolves.toBeUndefined();
    const s = useHistoryStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.loadError).toBe("浏览器存储不可用（可能处于隐私模式）");
    expect(s.hands).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it("openDB 拒绝（隐私模式/配额瞬态）：同样进入错误终态", async () => {
    openDBImpl = () => Promise.reject(new Error("openDB blocked"));
    const { useHistoryStore } = await freshStore();
    await useHistoryStore.getState().loadAll();
    const s = useHistoryStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.loadError).toBe("浏览器存储不可用（可能处于隐私模式）");
  });

  it("重试恢复：失败后修好环境再次 loadAll，数据正常加载且 loadError 清空", async () => {
    openDBImpl = () => Promise.reject(new Error("transient"));
    const { useHistoryStore } = await freshStore();
    await useHistoryStore.getState().loadAll();
    expect(useHistoryStore.getState().loadError).not.toBeNull();

    const { db } = makeDb({ hands: [mkHand("r1", 1)] });
    openDBImpl = () => Promise.resolve(db);
    await useHistoryStore.getState().loadAll();
    const s = useHistoryStore.getState();
    expect(s.loadError).toBeNull();
    expect(s.hands.map((h) => h.id)).toEqual(["r1"]);
  });
});

// ---------------------------------------------------------------------------
// E2：openDB 失败的 promise 不缓存
// ---------------------------------------------------------------------------

describe("openDB 失败重试（E2）", () => {
  it("连续失败两次：每次都重新调 openDB（不缓存 rejected promise）", async () => {
    openDBImpl = () => Promise.reject(new Error("blocked"));
    const { useHistoryStore } = await freshStore();
    await useHistoryStore.getState().loadAll();
    await useHistoryStore.getState().loadAll();
    expect(openDBCalls).toBe(2);
    expect(useHistoryStore.getState().loadError).not.toBeNull();
  });

  it("失败后成功：成功结果随后被缓存复用（第二次成功不再调 openDB）", async () => {
    openDBImpl = () => Promise.reject(new Error("blocked"));
    const { useHistoryStore } = await freshStore();
    await useHistoryStore.getState().loadAll();
    expect(openDBCalls).toBe(1);

    const { db } = makeDb({ hands: [] });
    openDBImpl = () => Promise.resolve(db);
    await useHistoryStore.getState().loadAll();
    await useHistoryStore.getState().loadAll();
    expect(openDBCalls).toBe(2); // 只重试一次即成功并缓存
    expect(useHistoryStore.getState().loadError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E3：saveHand 乐观更新（先内存后落库）
// ---------------------------------------------------------------------------

describe("saveHand 乐观更新（E3）", () => {
  it("落库失败：不抛异常，记录保留在内存，console.error 记录原因", async () => {
    const { db, tables } = makeDb({}, { failPuts: true });
    openDBImpl = () => Promise.resolve(db);

    const { useHistoryStore } = await freshStore();
    await useHistoryStore.getState().loadAll();

    const rec = mkHand("s1", 100);
    await expect(useHistoryStore.getState().saveHand(rec)).resolves.toBeUndefined();
    expect(useHistoryStore.getState().hands.map((h) => h.id)).toEqual(["s1"]);
    expect(tables.hands).toHaveLength(0); // 没落盘
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain("落库失败");
  });

  it("IndexedDB 整体不可用：saveHand 同样保留内存数据", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const { useHistoryStore } = await freshStore();
    const rec = mkHand("s2", 100);
    await expect(useHistoryStore.getState().saveHand(rec)).resolves.toBeUndefined();
    expect(useHistoryStore.getState().hands.map((h) => h.id)).toEqual(["s2"]);
    expect(console.error).toHaveBeenCalled();
  });

  it("正常路径：内存与 IDB 都写入；同 id 覆盖不重复", async () => {
    const { db, tables } = makeDb();
    openDBImpl = () => Promise.resolve(db);

    const { useHistoryStore } = await freshStore();
    await useHistoryStore.getState().saveHand(mkHand("a", 100));
    await useHistoryStore.getState().saveHand(mkHand("b", 200));
    await useHistoryStore.getState().saveHand({ ...mkHand("a", 300), profit: 99 });

    const s = useHistoryStore.getState();
    expect(s.hands.map((h) => h.id)).toEqual(["a", "b"]); // 时间倒序，a 覆盖后 ts=300 最前
    expect(s.hands[0].profit).toBe(99);
    expect(tables.hands).toHaveLength(2);
    expect(console.error).not.toHaveBeenCalled();
  });
});
