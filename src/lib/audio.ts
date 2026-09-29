/**
 * 牌桌音效（零素材 WebAudio 合成）：
 * - AudioContext 懒初始化：首次 playSound 时创建；浏览器自动播放策略下
 *   suspended 的 context 每次播放前尝试 resume（首次用户手势后生效）；
 * - 开关存 pokergto_sound（"1" 开 / "0" 关，缺省开），经统一设置存储
 *   （原生 Preferences + localStorage 镜像，见 lib/storage/settings.ts）；
 * - SSR / node 测试环境（无 window / AudioContext）全部静默 no-op，
 *   import 与调用均安全。
 */

import { getItemSync, setItem } from "@/lib/storage/settings";

export type SoundName =
  | "deal"
  | "chip"
  | "check"
  | "allin"
  | "win"
  | "lose"
  | "bust"
  | "levelup";

const STORAGE_KEY = "pokergto_sound";

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  return ctx;
}

export function isSoundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return getItemSync(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  // 同步更新镜像 + 内存缓存，原生异步落 Preferences
  void setItem(STORAGE_KEY, on ? "1" : "0");
}

interface ToneOpts {
  /** 起始频率 Hz */
  freq: number;
  /** 结束频率 Hz（指数滑动；缺省不变） */
  freqEnd?: number;
  /** 相对当前时刻的延迟（秒） */
  at?: number;
  /** 时长（秒） */
  dur: number;
  type?: OscillatorType;
  /** 峰值音量 0-1 */
  gain: number;
}

/** 单音：oscillator + 快速起音/指数衰减包络 */
function tone(c: AudioContext, o: ToneOpts): void {
  const t0 = c.currentTime + (o.at ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.freqEnd && o.freqEnd > 0) {
    osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + o.dur);
  }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.02);
}

/** 噪声 burst：白噪声 + 带通滤波 + 快速衰减（发牌/筹码 click） */
function noiseBurst(
  c: AudioContext,
  o: { at?: number; dur: number; filterFreq: number; gain: number },
): void {
  const t0 = c.currentTime + (o.at ?? 0);
  const len = Math.max(1, Math.ceil(c.sampleRate * o.dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = o.filterFreq;
  filter.Q.value = 1.1;
  const g = c.createGain();
  g.gain.setValueAtTime(o.gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  src.connect(filter).connect(g).connect(c.destination);
  src.start(t0);
  src.stop(t0 + o.dur);
}

const SOUNDS: Record<SoundName, (c: AudioContext) => void> = {
  // 发牌：短促高频噪声双 burst（两张手牌）
  deal: (c) => {
    noiseBurst(c, { dur: 0.05, filterFreq: 5200, gain: 0.22 });
    noiseBurst(c, { at: 0.07, dur: 0.05, filterFreq: 4600, gain: 0.18 });
  },
  // 筹码：高频 click + 低频 tick 体
  chip: (c) => {
    noiseBurst(c, { dur: 0.03, filterFreq: 2400, gain: 0.2 });
    tone(c, { freq: 210, freqEnd: 120, dur: 0.06, type: "triangle", gain: 0.25 });
  },
  // 过牌：轻敲木桌
  check: (c) => {
    tone(c, { freq: 950, freqEnd: 700, dur: 0.045, gain: 0.12 });
  },
  // all-in：三连升调（square 轻音量）
  allin: (c) => {
    tone(c, { freq: 330, dur: 0.09, type: "square", gain: 0.12 });
    tone(c, { freq: 440, at: 0.09, dur: 0.09, type: "square", gain: 0.12 });
    tone(c, { freq: 560, at: 0.18, dur: 0.14, type: "square", gain: 0.14 });
  },
  // 胜利：上行琶音 C5-E5-G5-C6
  win: (c) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      tone(c, { freq: f, at: i * 0.1, dur: 0.18, type: "triangle", gain: 0.16 }),
    );
  },
  // 失利：下行两音
  lose: (c) => {
    tone(c, { freq: 320, dur: 0.12, gain: 0.15 });
    tone(c, { freq: 220, at: 0.12, dur: 0.18, gain: 0.15 });
  },
  // 淘汰：下行三音（更低更长）
  bust: (c) => {
    tone(c, { freq: 300, dur: 0.13, type: "sawtooth", gain: 0.09 });
    tone(c, { freq: 215, at: 0.13, dur: 0.13, type: "sawtooth", gain: 0.09 });
    tone(c, { freq: 140, at: 0.26, dur: 0.22, type: "sawtooth", gain: 0.1 });
  },
  // 升盲：明亮三连升
  levelup: (c) => {
    tone(c, { freq: 440, dur: 0.1, type: "triangle", gain: 0.16 });
    tone(c, { freq: 587.33, at: 0.1, dur: 0.1, type: "triangle", gain: 0.16 });
    tone(c, { freq: 880, at: 0.2, dur: 0.18, type: "triangle", gain: 0.18 });
  },
};

/** 播放合成音效；开关关闭 / 无 AudioContext / 合成异常时静默 */
export function playSound(name: SoundName): void {
  try {
    if (!isSoundEnabled()) return;
    const c = getContext();
    if (!c) return;
    SOUNDS[name](c);
  } catch {
    // 音频不可用不阻断牌局
  }
}
