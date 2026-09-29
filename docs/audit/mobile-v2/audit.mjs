/**
 * 移动端 UI 体检脚本（375x667 / 390x844 视口）
 *
 * 用法：
 *   node docs/audit/mobile-v2/audit.mjs <phase> [--desktop]
 *     <phase>   before | after（截图目录 shots/<phase>/）
 *     --desktop 只拍桌面 1600x900 基线/对比图（shots/<phase>/desktop-*.png）
 *
 * 检查项（每页每视口）：
 *   1. 横向溢出：document.documentElement.scrollWidth > innerWidth + 1
 *   2. 未被裁剪的越界元素：rect.right > vw+1 / rect.left < -1，且无 overflow-x
 *      hidden/auto/scroll 的祖先把它收在视口内
 *   3. 触控目标：可见可点元素 min(width,height) < 44px（分级 <34 / <40 / <44）
 *   4. 文字截断：nowrap 元素 scrollWidth > clientWidth + 2（按钮/徽标/表头/单元格）
 *
 * 数据页（/history /history/:id /stats）先向 IndexedDB 注入合成手牌记录。
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3105";
const OUT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const phase = process.argv[2] ?? "before";
const desktopOnly = process.argv.includes("--desktop");
const SHOTS = path.join(OUT, "shots", phase);
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { name: "se375", width: 375, height: 667 },
  { name: "i14-390", width: 390, height: 844 },
];
const DESKTOP = { name: "desktop", width: 1600, height: 900 };

/** 合成手牌记录（14 手：2/6/9 人桌、多种风格、盈亏/位置/摊牌覆盖） */
function makeHands() {
  const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
  const SUITS = ["s", "h", "d", "c"];
  let ci = 0;
  const card = () => `${RANKS[ci % 13]}${SUITS[ci++ % 4]}`;
  const styles = ["nit", "tag", "lag", "maniac", "calling_station", "gto"];
  const hands = [];
  const configs = [
    { seats: 6, n: 8 },
    { seats: 2, n: 3 },
    { seats: 9, n: 3 },
  ];
  let ts = Date.now() - 14 * 3600_000;
  let idn = 0;
  for (const cfg of configs) {
    for (let k = 0; k < cfg.n; k++) {
      const seats = cfg.seats;
      const heroSeat = 0;
      const buttonSeat = (k * 2) % seats;
      const showdown = k % 2 === 0;
      const profit = ((k * 37 + seats * 11) % 180) - 90;
      const players = [];
      for (let s = 0; s < seats; s++) {
        const isHero = s === heroSeat;
        players.push({
          seat: s,
          isHero,
          aiStyle: isHero ? null : styles[(s + k) % styles.length],
          cards: isHero || (showdown && s === (heroSeat + 1) % seats) ? [card(), card()] : null,
          profit: isHero ? profit : Math.round(-profit / (seats - 1)),
        });
      }
      const streets = [
        {
          street: "preflop",
          board: [],
          actions: [
            { seat: (buttonSeat + 3) % seats, action: { type: "raise", amount: 6 } },
            { seat: heroSeat, action: { type: k % 3 === 0 ? "call" : "fold", amount: k % 3 === 0 ? 6 : 0 } },
          ],
        },
      ];
      const finalBoard = [card(), card(), card(), card(), card()];
      if (k % 3 === 0) {
        streets.push({
          street: "flop",
          board: finalBoard.slice(0, 3),
          actions: [
            { seat: heroSeat, action: { type: "bet", amount: 10 } },
            { seat: (heroSeat + 1) % seats, action: { type: "call", amount: 10 } },
          ],
        });
      }
      hands.push({
        id: `audit-hand-${idn++}`,
        timestamp: (ts += 3600_000),
        mode: seats === 9 ? "tournament" : "cash",
        tournamentSeats: seats === 9 ? 9 : undefined,
        players,
        heroSeat,
        buttonSeat,
        smallBlind: 1,
        bigBlind: 2,
        ante: seats === 9 ? 1 : 0,
        streets,
        finalBoard,
        result: profit > 0 ? "win" : profit < 0 ? "lose" : "tie",
        profit,
        showdown,
      });
    }
  }
  return hands;
}

async function seed(page) {
  const hands = makeHands();
  await page.evaluate(async (hands) => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open("pokergto", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("hands")) db.createObjectStore("hands", { keyPath: "id" });
        if (!db.objectStoreNames.contains("analyses")) db.createObjectStore("analyses", { keyPath: "handId" });
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("hands", "readwrite");
        for (const h of hands) tx.objectStore("hands").put(h);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  }, hands);
  return hands[0].id; // 最新一手（时间倒序第一条）
}

/** 页面内布局体检（返回结构化结果） */
function auditLayout() {
  const vw = window.innerWidth;
  const res = {
    vw,
    bodySW: document.body.scrollWidth,
    docSW: document.documentElement.scrollWidth,
    hOverflow: document.documentElement.scrollWidth > vw + 1,
    overflowEls: [],
    smallTargets: [],
    truncated: [],
  };
  const short = (el) => {
    const cls = (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".");
    const tag = el.tagName.toLowerCase();
    const txt = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
    return `${tag}${cls ? "." + cls : ""} "${txt}"`;
  };
  const inClipper = (el) => {
    let p = el.parentElement;
    while (p) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden") {
        const pr = p.getBoundingClientRect();
        if (pr.right <= vw + 1 && pr.left >= -1) return true;
      }
      p = p.parentElement;
    }
    return false;
  };
  // 越界元素（仅报叶子级/小元素，避免整树重复上报）
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.right > vw + 1 || r.left < -1) {
      if (el.children.length > 2 && r.width > vw) continue; // 祖先会被其违规后代代表
      if (inClipper(el)) continue;
      res.overflowEls.push({ el: short(el), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) });
      if (res.overflowEls.length > 25) break;
    }
  }
  // 触控目标
  const seen = new Set();
  for (const el of document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (getComputedStyle(el).visibility === "hidden") continue;
    const minDim = Math.min(r.width, r.height);
    if (minDim < 44) {
      const key = short(el) + Math.round(r.x) + "," + Math.round(r.y);
      if (seen.has(key)) continue;
      seen.add(key);
      res.smallTargets.push({
        el: short(el),
        w: Math.round(r.width),
        h: Math.round(r.height),
        type: el.tagName.toLowerCase() === "input" ? el.getAttribute("type") : undefined,
      });
    }
  }
  // 文字截断（nowrap 且内容宽于盒子；排除横向滚动容器内的元素）
  for (const el of document.querySelectorAll("button, a, th, td, h1, h2, h3, span, label")) {
    const cs = getComputedStyle(el);
    if (cs.whiteSpace !== "nowrap" && cs.whiteSpace !== "pre") continue;
    if (el.scrollWidth > el.clientWidth + 2 && !inClipper(el)) {
      res.truncated.push({ el: short(el), sw: el.scrollWidth, cw: el.clientWidth });
    }
  }
  return res;
}

const PAGES = [
  { name: "lobby", path: "/" },
  { name: "play-2max", path: "/play?mode=cash&seats=2&aiStyle=random&sb=1&bb=2&buyin=200", play: true },
  { name: "play-6max", path: "/play?mode=cash&seats=6&aiStyle=random&sb=1&bb=2&buyin=200", play: true },
  { name: "play-9max", path: "/play?mode=tournament&seats=9&aiStyle=random", play: true },
  { name: "history", path: "/history", seed: true },
  { name: "replay", path: "REPLAY", seed: true },
  { name: "stats", path: "/stats", seed: true },
  { name: "trainer-pushfold", path: "/trainer" },
  { name: "trainer-3bet", path: "/trainer", tab: "翻前 3bet" },
  { name: "trainer-flop", path: "/trainer", tab: "翻牌圈" },
  { name: "trainer-turn", path: "/trainer", tab: "转牌圈" },
  { name: "trainer-river", path: "/trainer", tab: "河牌圈" },
  { name: "ranges", path: "/ranges" },
  { name: "equity", path: "/equity" },
  { name: "settings", path: "/settings" },
];

async function waitStable(page, pg) {
  if (pg.play) {
    // 等 hero 底牌发出 + 发牌动画落定
    await page.locator("div.bg-white").first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    return;
  }
  await page.waitForTimeout(1200);
}

async function run() {
  const browser = await chromium.launch();
  const report = {};
  const vps = desktopOnly ? [DESKTOP] : VIEWPORTS;
  for (const vp of vps) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: !desktopOnly,
      hasTouch: !desktopOnly,
      locale: "zh-CN",
    });
    const page = await context.newPage();
    page.on("pageerror", () => {});
    let replayId = null;
    for (const pg of PAGES) {
      const key = `${vp.name}/${pg.name}`;
      try {
        if (pg.seed && replayId === null) {
          await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
          replayId = await seed(page);
        }
        const url = pg.path === "REPLAY" ? `/history/${replayId}` : pg.path;
        // 前一页 fullPage 截图可能残留放大后的视口，每页导航前重置
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(BASE + url, { waitUntil: "domcontentloaded" });
        if (pg.tab) {
          await page.getByRole("button", { name: pg.tab, exact: true }).click();
        }
        await waitStable(page, pg);
        const r = await page.evaluate(auditLayout);
        report[key] = r;
        await page.screenshot({
          path: path.join(SHOTS, `${vp.name}-${pg.name}.png`),
          fullPage: !pg.play,
        });
        console.log(
          `${key}: hOverflow=${r.hOverflow} overflowEls=${r.overflowEls.length} small<44=${r.smallTargets.length} truncated=${r.truncated.length}`,
        );
      } catch (e) {
        report[key] = { error: String(e).slice(0, 300) };
        console.log(`${key}: ERROR ${String(e).slice(0, 200)}`);
      }
    }
    await context.close();
  }
  writeFileSync(path.join(OUT, `audit-${phase}${desktopOnly ? "-desktop" : ""}.json`), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(`\nDone → ${path.join(OUT, `audit-${phase}${desktopOnly ? "-desktop" : ""}.json`)}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
