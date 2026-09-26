/**
 * audio.ts 环境安全测试：node（无 window / AudioContext）下 import 与调用
 * 全部静默 no-op，不抛错。
 */
import { describe, expect, it } from "vitest";
import {
  isSoundEnabled,
  playSound,
  setSoundEnabled,
  type SoundName,
} from "@/lib/audio";

describe("audio（node 无 window/AudioContext 环境静默安全）", () => {
  it("全部音效 playSound 不抛错", () => {
    const names: SoundName[] = [
      "deal",
      "chip",
      "check",
      "allin",
      "win",
      "lose",
      "bust",
      "levelup",
    ];
    for (const n of names) {
      expect(() => playSound(n)).not.toThrow();
    }
  });

  it("开关缺省开；无 window 下读写静默", () => {
    expect(isSoundEnabled()).toBe(true);
    expect(() => setSoundEnabled(false)).not.toThrow();
    expect(() => setSoundEnabled(true)).not.toThrow();
    // 无 window：写入被跳过，读取仍回默认开
    expect(isSoundEnabled()).toBe(true);
  });
});
