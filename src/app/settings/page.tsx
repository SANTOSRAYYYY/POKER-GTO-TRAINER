"use client";

import { useEffect, useState } from "react";
import { Nav } from "@/components/history/Nav";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import { chatCompletion } from "@/lib/llm/client";
import type { AIStyle, LLMConfig, ReasoningEffort } from "@/lib/types";

const LLM_CONFIG_KEY = "pokergto_llm_config";
const DEFAULT_STYLE_KEY = "pokergto_default_style";
const AI_ENGINE_KEY = "pokergto_ai_engine";

/** AI 决策引擎：heuristic = 本地启发式（快、免费）；llm = 每个 AI 决策都调大模型（慢、消耗 token） */
type AIEngine = "heuristic" | "llm";

const DEFAULT_CONFIG: LLMConfig = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
};

const STYLE_OPTIONS: { id: AIStyle; labelKey: DictKey }[] = [
  { id: "random", labelKey: "settings.style.random" },
  { id: "nit", labelKey: "lobby.style.nit" },
  { id: "tag", labelKey: "lobby.style.tag" },
  { id: "lag", labelKey: "lobby.style.lag" },
  { id: "maniac", labelKey: "lobby.style.maniac" },
  { id: "calling_station", labelKey: "lobby.style.calling_station" },
  { id: "gto", labelKey: "lobby.style.gto" },
];

/** 思考程度选项：空串表示「默认（不发送）」，对应 config.reasoningEffort === undefined */
const EFFORT_OPTIONS: { value: "" | ReasoningEffort; labelKey: DictKey }[] = [
  { value: "", labelKey: "settings.effort.default" },
  { value: "low", labelKey: "settings.effort.low" },
  { value: "medium", labelKey: "settings.effort.medium" },
  { value: "high", labelKey: "settings.effort.high" },
  { value: "max", labelKey: "settings.effort.max" },
];

/** 思考模式开关选项：空串 = 不发送（DeepSeek 默认开启思考且 effort=high） */
const THINKING_OPTIONS: { value: "" | "on" | "off"; labelKey: DictKey }[] = [
  { value: "", labelKey: "settings.thinking.default" },
  { value: "on", labelKey: "settings.thinking.on" },
  { value: "off", labelKey: "settings.thinking.off" },
];

const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "max"];

type TestStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" | "warn" | "fail"; key: DictKey; vars?: Record<string, string | number> };

/** 复盘格式测试的慢响应阈值：小 JSON 任务都超过 20s，长复盘分析大概率超时 */
const FORMAT_TEST_SLOW_MS = 20_000;

export default function SettingsPage() {
  const { t } = useI18n();
  const [config, setConfig] = useState<LLMConfig>(DEFAULT_CONFIG);
  const [defaultStyle, setDefaultStyle] = useState<AIStyle>("random");
  const [aiEngine, setAiEngine] = useState<AIEngine>("heuristic");
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestStatus>({ kind: "idle" });
  const [formatTest, setFormatTest] = useState<TestStatus>({ kind: "idle" });

  // 首屏以 DEFAULT_CONFIG 渲染（SSR 与客户端一致，无 hydration 偏差），
  // 挂载后再用 localStorage 覆盖，避免读取差异导致 hydration mismatch。
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LLM_CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<LLMConfig>;
        setConfig({
          apiKey: parsed.apiKey ?? "",
          baseUrl: parsed.baseUrl || DEFAULT_CONFIG.baseUrl,
          model: parsed.model || DEFAULT_CONFIG.model,
          temperature: parsed.temperature,
          // 旧配置没有这两个字段 → undefined（不发送）；非法值同样按未设置处理
          reasoningEffort: REASONING_EFFORTS.includes(parsed.reasoningEffort as ReasoningEffort)
            ? (parsed.reasoningEffort as ReasoningEffort)
            : undefined,
          maxTokens:
            typeof parsed.maxTokens === "number" &&
            Number.isFinite(parsed.maxTokens) &&
            parsed.maxTokens > 0
              ? Math.floor(parsed.maxTokens)
              : undefined,
          thinkingEnabled:
            typeof parsed.thinkingEnabled === "boolean"
              ? parsed.thinkingEnabled
              : undefined,
          jsonOutput:
            typeof parsed.jsonOutput === "boolean"
              ? parsed.jsonOutput
              : undefined,
          contextHands:
            typeof parsed.contextHands === "number" &&
            Number.isFinite(parsed.contextHands) &&
            parsed.contextHands > 0
              ? Math.min(20, Math.floor(parsed.contextHands))
              : undefined,
          promptStyle:
            parsed.promptStyle === "full" || parsed.promptStyle === "slim"
              ? parsed.promptStyle
              : undefined,
        });
      }
      const style = window.localStorage.getItem(DEFAULT_STYLE_KEY);
      if (style && STYLE_OPTIONS.some((o) => o.id === style)) {
        setDefaultStyle(style as AIStyle);
      }
      const engine = window.localStorage.getItem(AI_ENGINE_KEY);
      if (engine === "heuristic" || engine === "llm") {
        setAiEngine(engine);
      }
    } catch {
      // 忽略损坏的本地配置
    }
  }, []);

  const save = () => {
    window.localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(config));
    window.localStorage.setItem(DEFAULT_STYLE_KEY, defaultStyle);
    window.localStorage.setItem(AI_ENGINE_KEY, aiEngine);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  };

  const testConnection = async () => {
    setTest({ kind: "testing" });
    try {
      const reply = await chatCompletion(config, [
        { role: "user", content: "ping（请只回复 pong）" },
      ]);
      setTest({ kind: "ok", key: "settings.testOk", vars: { reply: reply.slice(0, 80) } });
    } catch (e) {
      setTest(
        e instanceof Error
          ? { kind: "fail", key: "settings.testRawError", vars: { msg: e.message } }
          : { kind: "fail", key: "settings.testFail" },
      );
    }
  };

  /**
   * 复盘格式测试：发一个要求输出 {"ok":true} 的小 JSON 任务，
   * 验证模型能否按指令输出合法 JSON，并计时——小任务都慢（>20s）的话，
   * 长复盘分析大概率会超时。
   */
  const testReviewFormat = async () => {
    setFormatTest({ kind: "testing" });
    const started = performance.now();
    const elapsedText = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;
    try {
      const reply = await chatCompletion(config, [
        {
          role: "system",
          content:
            "你是 JSON 输出助手。只输出一个严格合法的 JSON 对象，不要输出任何其他文字，不要用 markdown 代码块包裹。",
        },
        { role: "user", content: '请输出 {"ok":true}' },
      ]);
      const slow = performance.now() - started > FORMAT_TEST_SLOW_MS;
      const seconds = elapsedText();
      // 容错提取 JSON（容忍 markdown 围栏与前言后语），与复盘解析策略一致
      let parsed: unknown = null;
      try {
        let txt = reply.trim();
        const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(txt);
        if (fence) txt = fence[1].trim();
        const start = txt.indexOf("{");
        const end = txt.lastIndexOf("}");
        if (start >= 0 && end > start) parsed = JSON.parse(txt.slice(start, end + 1));
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== "object") {
        setFormatTest({
          kind: "fail",
          key: "settings.fmtNoJson",
          vars: { s: seconds, reply: reply.slice(0, 80) },
        });
        return;
      }
      if ((parsed as { ok?: unknown }).ok !== true) {
        setFormatTest(
          slow
            ? { kind: "warn", key: "settings.fmtNotOkSlow", vars: { s: seconds } }
            : { kind: "warn", key: "settings.fmtNotOk", vars: { s: seconds } },
        );
      } else if (slow) {
        setFormatTest({ kind: "warn", key: "settings.fmtOkSlow", vars: { s: seconds } });
      } else {
        setFormatTest({ kind: "ok", key: "settings.fmtOk", vars: { s: seconds } });
      }
    } catch (e) {
      setFormatTest(
        e instanceof Error
          ? { kind: "fail", key: "settings.fmtFail", vars: { msg: e.message, s: elapsedText() } }
          : { kind: "fail", key: "settings.fmtFailNoMsg", vars: { s: elapsedText() } },
      );
    }
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <Nav />
      <div className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-6 text-2xl font-bold">{t("settings.title")}</h1>

        <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="mb-1 font-semibold">{t("settings.llm.title")}</h2>
          <p className="mb-4 text-xs leading-5 text-zinc-500">
            {t("settings.llm.desc")}
          </p>

          <label className="mb-3 block">
            <span className="mb-1 block text-sm text-zinc-400">{t("settings.apiKey")}</span>
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
              placeholder="sk-..."
              autoComplete="off"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none max-md:py-3"
            />
          </label>

          <label className="mb-3 block">
            <span className="mb-1 block text-sm text-zinc-400">{t("settings.baseUrl")}</span>
            <input
              type="text"
              value={config.baseUrl}
              onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
              placeholder="https://api.deepseek.com"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none max-md:py-3"
            />
          </label>

          <label className="mb-4 block">
            <span className="mb-1 block text-sm text-zinc-400">{t("settings.model")}</span>
            <input
              type="text"
              value={config.model}
              onChange={(e) => setConfig({ ...config, model: e.target.value })}
              placeholder="deepseek-flash"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none max-md:py-3"
            />
          </label>

          <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="mb-2 text-sm text-zinc-400">{t("settings.advanced")}</div>

            <div className="mb-3">
              <span className="mb-1 block text-sm text-zinc-400">{t("settings.effort")}</span>
              <div className="flex flex-wrap gap-3">
                {EFFORT_OPTIONS.map((o) => (
                  <label key={o.value || "default"} className="flex items-center gap-1.5 text-sm max-md:py-2.5">
                    <input
                      type="radio"
                      name="reasoning-effort"
                      value={o.value}
                      checked={(config.reasoningEffort ?? "") === o.value}
                      onChange={() =>
                        setConfig({
                          ...config,
                          reasoningEffort: o.value === "" ? undefined : o.value,
                        })
                      }
                      className="accent-emerald-500"
                    />
                    {t(o.labelKey)}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {t("settings.effortHint")}
              </p>
            </div>

            <div className="mb-3">
              <span className="mb-1 block text-sm text-zinc-400">{t("settings.thinking")}</span>
              <div className="flex flex-wrap gap-3">
                {THINKING_OPTIONS.map((o) => (
                  <label key={o.value || "default"} className="flex items-center gap-1.5 text-sm max-md:py-2.5">
                    <input
                      type="radio"
                      name="thinking-mode"
                      value={o.value}
                      checked={
                        (config.thinkingEnabled === undefined
                          ? ""
                          : config.thinkingEnabled
                            ? "on"
                            : "off") === o.value
                      }
                      onChange={() =>
                        setConfig({
                          ...config,
                          thinkingEnabled:
                            o.value === "" ? undefined : o.value === "on",
                        })
                      }
                      className="accent-emerald-500"
                    />
                    {t(o.labelKey)}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {t("settings.thinkingHint")}
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm max-md:py-2.5">
              <input
                type="checkbox"
                checked={config.jsonOutput === true}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    jsonOutput: e.target.checked ? true : undefined,
                  })
                }
                className="accent-emerald-500"
              />
              {t("settings.jsonOutput")}
            </label>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              {t("settings.jsonHint")}
            </p>

            <label className="mt-3 block">
              <span className="mb-1 block text-sm text-zinc-400">
                {t("settings.contextHands")}
              </span>
              <input
                type="number"
                min={0}
                max={20}
                step={1}
                value={config.contextHands ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    setConfig({ ...config, contextHands: undefined });
                    return;
                  }
                  const n = Number(v);
                  if (Number.isFinite(n) && n > 0) {
                    setConfig({
                      ...config,
                      contextHands: Math.min(20, Math.floor(n)),
                    });
                  }
                }}
                placeholder="0"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none max-md:py-3"
              />
            </label>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              {t("settings.contextHintA")}
              <span className="text-amber-400/90">{t("settings.contextHintEm")}</span>
              {t("settings.contextHintB")}
            </p>

            <div className="mt-3">
              <span className="mb-1 block text-sm text-zinc-400">{t("settings.promptStyle")}</span>
              <div className="flex flex-wrap gap-3">
                {(
                  [
                    { value: "slim", labelKey: "settings.promptStyle.slim" },
                    { value: "full", labelKey: "settings.promptStyle.full" },
                  ] as { value: string; labelKey: DictKey }[]
                ).map((o) => (
                  <label key={o.value} className="flex items-center gap-1.5 text-sm max-md:py-2.5">
                    <input
                      type="radio"
                      name="prompt-style"
                      value={o.value}
                      checked={(config.promptStyle ?? "slim") === o.value}
                      onChange={() =>
                        setConfig({
                          ...config,
                          promptStyle: o.value === "slim" ? undefined : "full",
                        })
                      }
                      className="accent-emerald-500"
                    />
                    {t(o.labelKey)}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {t("settings.promptStyleHint")}
              </p>
            </div>

            <label className="block">
              <span className="mb-1 block text-sm text-zinc-400">{t("settings.maxTokens")}</span>
              <input
                type="number"
                min={1}
                step={1}
                value={config.maxTokens ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    setConfig({ ...config, maxTokens: undefined });
                    return;
                  }
                  const n = Number(v);
                  if (Number.isFinite(n) && n > 0) {
                    setConfig({ ...config, maxTokens: Math.floor(n) });
                  }
                }}
                placeholder="4096"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none max-md:py-3"
              />
            </label>
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              {t("settings.maxTokensHintA")}
              <span className="text-amber-400/90">
                {t("settings.maxTokensHintEm")}
              </span>
              {t("settings.maxTokensHintB")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void testConnection()}
              disabled={test.kind === "testing" || formatTest.kind === "testing" || !config.apiKey}
              className="rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-40 max-md:py-3"
            >
              {test.kind === "testing" ? t("settings.testing") : t("settings.testConnection")}
            </button>
            <button
              onClick={() => void testReviewFormat()}
              disabled={test.kind === "testing" || formatTest.kind === "testing" || !config.apiKey}
              className="rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-40 max-md:py-3"
            >
              {formatTest.kind === "testing" ? t("settings.testing") : t("settings.testFormat")}
            </button>
            {test.kind === "ok" && (
              <span className="text-sm text-emerald-400">✓ {t(test.key, test.vars)}</span>
            )}
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {t("settings.testFormatHint")}
          </p>
          {test.kind === "fail" && (
            <div className="mt-3 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
              ✗ {t(test.key, test.vars)}
            </div>
          )}
          {formatTest.kind === "ok" && (
            <p className="mt-3 text-sm text-emerald-400">✓ {t(formatTest.key, formatTest.vars)}</p>
          )}
          {formatTest.kind === "warn" && (
            <div className="mt-3 rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-sm text-amber-300">
              ⚠ {t(formatTest.key, formatTest.vars)}
            </div>
          )}
          {formatTest.kind === "fail" && (
            <div className="mt-3 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
              ✗ {t(formatTest.key, formatTest.vars)}
            </div>
          )}
        </section>

        <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="mb-3 font-semibold">{t("settings.style.title")}</h2>
          <select
            value={defaultStyle}
            onChange={(e) => setDefaultStyle(e.target.value as AIStyle)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none max-md:py-3"
          >
            {STYLE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-zinc-500">{t("settings.styleHint")}</p>
        </section>

        <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="mb-3 font-semibold">{t("settings.engine.title")}</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              onClick={() => setAiEngine("heuristic")}
              className={`rounded-lg border p-3 text-left transition-colors ${
                aiEngine === "heuristic"
                  ? "border-emerald-500 bg-emerald-500/10"
                  : "border-zinc-700 bg-zinc-950 hover:border-zinc-500"
              }`}
            >
              <div className="text-sm font-medium text-zinc-100">{t("settings.engine.heuristic")}</div>
              <div className="mt-1 text-xs leading-5 text-zinc-500">
                {t("settings.engine.heuristicDesc")}
              </div>
            </button>
            <button
              onClick={() => setAiEngine("llm")}
              className={`rounded-lg border p-3 text-left transition-colors ${
                aiEngine === "llm"
                  ? "border-emerald-500 bg-emerald-500/10"
                  : "border-zinc-700 bg-zinc-950 hover:border-zinc-500"
              }`}
            >
              <div className="text-sm font-medium text-zinc-100">{t("settings.engine.llm")}</div>
              <div className="mt-1 text-xs leading-5 text-zinc-500">
                {t("settings.engine.llmDesc")}
              </div>
            </button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {t("settings.engineHint")}
          </p>
        </section>

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            className="rounded-lg bg-emerald-500 px-6 py-2.5 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400"
          >
            {t("settings.save")}
          </button>
          {saved && <span className="text-sm text-emerald-400">✓ {t("settings.saved")}</span>}
        </div>
      </div>
    </main>
  );
}
