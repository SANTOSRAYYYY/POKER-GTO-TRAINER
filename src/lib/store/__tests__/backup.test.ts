/**
 * 手牌历史备份/恢复（historyStore.exportBackup/importBackup）测试：
 *
 * - exportBackup：hands + analyses + 笔记本 + 成就 + 整场报告打成带
 *   app/version 标记的 JSON（idb 里的损坏记录在导出侧被过滤）；
 * - importBackup：手牌按 id 去重合并（重复/损坏计 skipped），分析缓存按
 *   handId 去重，成就只补缺失项，笔记本仅本地为空时恢复，整场报告按
 *   createdAt 去重合并且最多 5 份；非法 JSON / 非本应用备份 / 过新版本抛错。
 *
 * 方案与 historyStore.test.ts 相同：vi.mock("idb") 注入可控假 DB，
 * vi.resetModules + 动态 import 让每个用例拿到全新 store 单例。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisResult, HandRecord, SessionReport } from "@/lib/types";

// ---------------------------------------------------------------------------
// 可控假 IndexedDB（比 historyStore.test.ts 多 getAllKeys，导入去重要用）
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FakeTables {
  hands: unknown[];
  analyses: unknown[];
}

function makeDb(seed: Partial<FakeTables> = {}) {
  const tables: FakeTables = {
    hands: [...(seed.hands ?? [])],
    analyses: [...(seed.analyses ?? [])],
  };
  const keyOf = (store: keyof FakeTables) => (store === "hands" ? "id" : "handId");
  const db = {
    getAll: async (store: keyof FakeTables) => [...tables[store]],
    getAllKeys: async (store: keyof FakeTables) =>
      tables[store].map((r) => (r as Row)[keyOf(store)]),
    get: async (store: keyof FakeTables, id: string) =>
      tables[store].find((r) => (r as Row)[keyOf(store)] === id),
    put: async (store: keyof FakeTables, val: unknown) => {
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

let openDBImpl: () => Promise<unknown> = () => Promise.reject(new Error("未配置"));

vi.mock("idb", () => ({
  openDB: () => openDBImpl(),
}));

async function freshStore() {
  vi.resetModules();
  return import("@/lib/store/historyStore");
}

// ---------------------------------------------------------------------------
// localStorage 存根与夹具
// ---------------------------------------------------------------------------

let lsData: Map<string, string>;

function stubLocalStorage(seed: Record<string, string> = {}): void {
  lsData = new Map(Object.entries(seed));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => lsData.get(k) ?? null,
      setItem: (k: string, v: string) => {
        lsData.set(k, String(v));
      },
      removeItem: (k: string) => {
        lsData.delete(k);
      },
    },
  });
}

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

const ANALYSIS: AnalysisResult = {
  streets: [{ street: "preflop", rating: "good", comments: ["好"] }],
  overall: "总体不错",
  score: 80,
};

function mkReport(createdAt: number): SessionReport {
  return {
    createdAt,
    handsAnalyzed: 3,
    strengths: ["强项"],
    leaks: [{ title: "漏洞", detail: "细节" }],
    priorities: ["先练这个"],
    score: 70,
  };
}

const NOTEBOOK_V1 = JSON.stringify({
  version: 1,
  stats: { hands: 10, vpipHands: 5 },
  updatedAt: 123,
  handsRecorded: 10,
});

function mkBackup(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    app: "pokergto-trainer",
    version: 1,
    exportedAt: 1,
    hands: [],
    analyses: [],
    notebook: null,
    achievements: null,
    sessionReports: [],
    ...overrides,
  });
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", {}); // node 无 indexedDB，补占位让 getDB 走 openDB 分支
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubLocalStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// exportBackup
// ---------------------------------------------------------------------------

describe("exportBackup", () => {
  it("全量打包：hands（损坏过滤、时间倒序）+ analyses + 笔记本 + 成就 + 整场报告", async () => {
    const { db } = makeDb({
      hands: [mkHand("h1", 100), mkHand("h2", 200), { id: "bad" }],
      analyses: [
        { handId: "h1", result: ANALYSIS, createdAt: 5 },
        { handId: "", result: null }, // 形状非法，导出过滤
      ],
    });
    openDBImpl = () => Promise.resolve(db);
    stubLocalStorage({
      pokergto_hero_notebook: NOTEBOOK_V1,
      pokergto_achievements: JSON.stringify({ first_win: 100 }),
      pokergto_session_reports: JSON.stringify([mkReport(10)]),
    });

    const { useHistoryStore, BACKUP_APP, BACKUP_VERSION } = await freshStore();
    const { filename, json } = await useHistoryStore.getState().exportBackup();

    expect(filename).toMatch(/^pokergto-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const payload = JSON.parse(json);
    expect(payload.app).toBe(BACKUP_APP);
    expect(payload.version).toBe(BACKUP_VERSION);
    expect(typeof payload.exportedAt).toBe("number");
    expect(payload.hands.map((h: HandRecord) => h.id)).toEqual(["h2", "h1"]);
    expect(payload.analyses).toHaveLength(1);
    expect(payload.analyses[0].handId).toBe("h1");
    expect(payload.notebook.version).toBe(1);
    expect(payload.achievements).toEqual({ first_win: 100 });
    expect(payload.sessionReports).toHaveLength(1);
    expect(payload.sessionReports[0].createdAt).toBe(10);
  });

  it("IndexedDB 不可用时退化为内存态导出", async () => {
    openDBImpl = () => Promise.reject(new Error("idb 不可用"));
    const { useHistoryStore } = await freshStore();
    await useHistoryStore.getState().saveHand(mkHand("mem", 1));
    const { json } = await useHistoryStore.getState().exportBackup();
    const payload = JSON.parse(json);
    expect(payload.hands.map((h: HandRecord) => h.id)).toEqual(["mem"]);
  });
});

// ---------------------------------------------------------------------------
// importBackup
// ---------------------------------------------------------------------------

describe("importBackup", () => {
  it("按 id 去重合并：新增入库、重复/损坏计 skipped，分析缓存按 handId 去重", async () => {
    const { db, tables } = makeDb({
      hands: [mkHand("h1", 100)],
      analyses: [{ handId: "h1", result: ANALYSIS, createdAt: 5 }],
    });
    openDBImpl = () => Promise.resolve(db);

    const { useHistoryStore } = await freshStore();
    const result = await useHistoryStore.getState().importBackup(
      mkBackup({
        hands: [mkHand("h1"), mkHand("h3", 300), { id: "broken" }, mkHand("h3")],
        analyses: [
          { handId: "h1", result: ANALYSIS, createdAt: 6 }, // 已有：跳过
          { handId: "h3", result: ANALYSIS, createdAt: 7 }, // 新增
        ],
      }),
    );

    // h1 重复 + 损坏 1 条 + 文件内 h3 重复 1 条 = 3 条跳过
    expect(result).toEqual({ imported: 1, skipped: 3 });
    expect(tables.hands.map((r) => (r as Row).id).sort()).toEqual(["h1", "h3"]);
    // h1 的旧分析不被覆盖，h3 分析并入
    expect(tables.analyses).toHaveLength(2);
    expect(
      (tables.analyses.find((r) => (r as Row).handId === "h1") as Row).createdAt,
    ).toBe(5);
    // 内存态已刷新
    const s = useHistoryStore.getState();
    expect(s.hands.map((h) => h.id)).toEqual(["h3", "h1"]);
    expect(Object.keys(s.analyses).sort()).toEqual(["h1", "h3"]);
  });

  it("成就只补缺失项；笔记本仅本地为空时恢复；整场报告按 createdAt 去重合并", async () => {
    const { db } = makeDb();
    openDBImpl = () => Promise.resolve(db);
    stubLocalStorage({
      pokergto_achievements: JSON.stringify({ first_win: 100 }),
      pokergto_session_reports: JSON.stringify([mkReport(10)]),
    });

    const { useHistoryStore } = await freshStore();
    await useHistoryStore.getState().importBackup(
      mkBackup({
        achievements: { first_win: 50, first_title: 200 },
        notebook: JSON.parse(NOTEBOOK_V1),
        sessionReports: [mkReport(10), mkReport(20)],
      }),
    );

    // 成就：已有 first_win=100 保留（不被 50 覆盖），补入 first_title=200
    expect(JSON.parse(lsData.get("pokergto_achievements")!)).toEqual({
      first_win: 100,
      first_title: 200,
    });
    // 笔记本：本地为空 → 恢复
    expect(JSON.parse(lsData.get("pokergto_hero_notebook")!)).toMatchObject({
      version: 1,
      updatedAt: 123,
    });
    // 整场报告：createdAt=10 去重，并入 20，新的在前
    const reports = JSON.parse(lsData.get("pokergto_session_reports")!);
    expect(reports.map((r: SessionReport) => r.createdAt)).toEqual([20, 10]);
  });

  it("本地已有笔记本时导入不覆盖", async () => {
    const { db } = makeDb();
    openDBImpl = () => Promise.resolve(db);
    const localNb = JSON.stringify({
      version: 1,
      stats: { hands: 99 },
      updatedAt: 999,
      handsRecorded: 99,
    });
    stubLocalStorage({ pokergto_hero_notebook: localNb });

    const { useHistoryStore } = await freshStore();
    await useHistoryStore
      .getState()
      .importBackup(mkBackup({ notebook: JSON.parse(NOTEBOOK_V1) }));

    expect(lsData.get("pokergto_hero_notebook")).toBe(localNb);
  });

  it("整场报告合并后最多保留 5 份", async () => {
    const { db } = makeDb();
    openDBImpl = () => Promise.resolve(db);
    const { useHistoryStore } = await freshStore();
    await useHistoryStore.getState().importBackup(
      mkBackup({
        sessionReports: [60, 50, 40, 30, 20, 10].map(mkReport),
      }),
    );
    const reports = JSON.parse(lsData.get("pokergto_session_reports")!);
    expect(reports).toHaveLength(5);
    expect(reports[0].createdAt).toBe(60);
  });

  it("非法 JSON / 非本应用备份 / 版本过新：抛错且不写任何数据", async () => {
    const { db, tables } = makeDb();
    openDBImpl = () => Promise.resolve(db);
    const { useHistoryStore } = await freshStore();
    const st = useHistoryStore.getState();

    await expect(st.importBackup("not json {{{")).rejects.toThrow();
    await expect(st.importBackup("{}")).rejects.toThrow();
    await expect(
      st.importBackup(mkBackup({ app: "other-app" })),
    ).rejects.toThrow();
    await expect(st.importBackup(mkBackup({ version: 99 }))).rejects.toThrow();
    expect(tables.hands).toHaveLength(0);
  });
});
