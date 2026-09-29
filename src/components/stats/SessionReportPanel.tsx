"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import {
  analyzeSession,
  listSessionReports,
  SESSION_ANALYSIS_DEFAULT_LIMIT,
} from "@/lib/store/historyStore";
import type { LLMConfig, SessionReport } from "@/lib/types";

const LLM_CONFIG_KEY = "pokergto_llm_config";

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function scoreColor(score: number): string {
  if (score >= 80) return "#34d399";
  if (score >= 60) return "#fbbf24";
  return "#f87171";
}

/** 大评分环：SVG 圆环按 score/100 填充 */
function ScoreRing({ score }: { score: number }) {
  const { t } = useI18n();
  const r = 40;
  const c = 2 * Math.PI * r;
  const color = scoreColor(score);
  return (
    <svg width={104} height={104} viewBox="0 0 104 104" role="img" aria-label={t("stats.report.scoreAria", { score })}>
      <circle cx={52} cy={52} r={r} fill="none" stroke="#27272a" strokeWidth={8} />
      <circle
        cx={52}
        cy={52}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={8}
        strokeLinecap="round"
        strokeDasharray={`${(c * score) / 100} ${c}`}
        transform="rotate(-90 52 52)"
      />
      <text x={52} y={50} textAnchor="middle" fill={color} fontSize={24} fontWeight={700}>
        {score}
      </text>
      <text x={52} y={68} textAnchor="middle" fill="#71717a" fontSize={10}>
        {t("stats.report.scoreLabel")}
      </text>
    </svg>
  );
}

function readLLMConfig(): LLMConfig | null {
  try {
    const raw = window.localStorage.getItem(LLM_CONFIG_KEY);
    return raw ? (JSON.parse(raw) as LLMConfig) : null;
  } catch {
    return null;
  }
}

interface ReportError {
  key: DictKey;
  vars?: Record<string, string | number>;
  showSettings?: boolean;
}

/**
 * 整场复盘（Session 级 AI 教练）：按钮触发 analyzeSession，
 * 展示 strengths（绿）/ leaks（红）/ priorities（编号列表）/ 评分环；
 * 报告存 localStorage（最多 5 份），可切换查看历史报告。
 */
export function SessionReportPanel({ handsCount }: { handsCount: number }) {
  const { t } = useI18n();
  const [reports, setReports] = useState<SessionReport[]>([]);
  const [selected, setSelected] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ReportError | null>(null);

  useEffect(() => {
    setReports(listSessionReports());
  }, []);

  const report = reports[Math.min(selected, reports.length - 1)] ?? null;

  const onRun = async () => {
    setError(null);
    const config = readLLMConfig();
    if (!config || !config.apiKey) {
      setError({ key: "stats.report.noApiKey", showSettings: true });
      return;
    }
    setRunning(true);
    try {
      const rep = await analyzeSession(config);
      const stored = listSessionReports();
      setReports(stored.length > 0 ? stored : [rep]);
      setSelected(0);
    } catch (e) {
      setError(
        e instanceof Error
          ? { key: "stats.report.rawError", vars: { msg: e.message } }
          : { key: "stats.report.failed" },
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t("stats.report.title")}</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            {t("stats.report.subtitle", {
              n: Math.min(handsCount, SESSION_ANALYSIS_DEFAULT_LIMIT),
            })}
          </p>
        </div>
        <button
          onClick={() => void onRun()}
          disabled={running || handsCount === 0}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-50 max-md:py-3"
        >
          {running ? t("stats.report.running") : t("stats.report.run")}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          <p className="whitespace-pre-wrap break-all">{t(error.key, error.vars)}</p>
          {error.showSettings && (
            <Link href="/settings" className="mt-2 inline-block underline">
              {t("stats.report.goSettings")}
            </Link>
          )}
        </div>
      )}

      {!report && !error && (
        <p className="text-sm text-zinc-600">
          {t("stats.report.empty")}
        </p>
      )}

      {report && (
        <div>
          {reports.length > 1 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {reports.map((r, i) => (
                <button
                  key={r.createdAt}
                  onClick={() => setSelected(i)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    i === selected
                      ? "bg-emerald-500/15 font-medium text-emerald-400"
                      : "bg-zinc-800/60 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {i === 0 ? t("stats.report.latest") : ""}
                  {fmtTime(r.createdAt)}
                </button>
              ))}
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center gap-5">
            <ScoreRing score={report.score} />
            <div className="text-sm text-zinc-500">
              <div>{t("stats.report.handsAnalyzed", { n: report.handsAnalyzed })}</div>
              <div>{t("stats.report.createdAt", { time: fmtTime(report.createdAt) })}</div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* 强项 */}
            <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-4">
              <h3 className="mb-2 text-sm font-semibold text-emerald-300">{t("stats.report.strengths")}</h3>
              {report.strengths.length === 0 ? (
                <p className="text-sm text-zinc-500">{t("stats.report.notListed")}</p>
              ) : (
                <ul className="list-inside list-disc space-y-1.5 text-sm text-zinc-200">
                  {report.strengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              )}
            </div>

            {/* 漏洞 */}
            <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-4">
              <h3 className="mb-2 text-sm font-semibold text-red-300">{t("stats.report.leaks")}</h3>
              {report.leaks.length === 0 ? (
                <p className="text-sm text-zinc-500">{t("stats.report.notListed")}</p>
              ) : (
                <ul className="space-y-2.5">
                  {report.leaks.map((l, i) => (
                    <li key={i}>
                      <div className="text-sm font-medium text-red-200">
                        {i + 1}. {l.title}
                      </div>
                      {l.detail && (
                        <p className="mt-0.5 pl-4 text-sm leading-6 text-zinc-300">{l.detail}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* 练习优先级 */}
          <div className="mt-4 rounded-lg border border-zinc-700 bg-zinc-950/60 p-4">
            <h3 className="mb-2 text-sm font-semibold text-zinc-300">{t("stats.report.priorities")}</h3>
            {report.priorities.length === 0 ? (
              <p className="text-sm text-zinc-500">{t("stats.report.notListed")}</p>
            ) : (
              <ol className="space-y-1.5">
                {report.priorities.map((p, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-sm text-zinc-200">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-bold text-emerald-300">
                      {i + 1}
                    </span>
                    <span>{p}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
