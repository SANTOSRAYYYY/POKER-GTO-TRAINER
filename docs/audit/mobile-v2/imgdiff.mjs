/**
 * 桌面零变化验证：逐页对比 shots/before 与 shots/after 的 desktop-*.png。
 * 输出每页差异像素数与差异率；任一像素 RGBA 不同即计 1。
 * 用法：node docs/audit/mobile-v2/imgdiff.mjs [beforeDir] [afterDir]
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const OUT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const dirA = process.argv[2] ?? path.join(OUT, "shots", "before");
const dirB = process.argv[3] ?? path.join(OUT, "shots", "after");

const files = readdirSync(dirA).filter((f) => f.startsWith("desktop-") && f.endsWith(".png"));
let worst = 0;
let allSame = true;
for (const f of files) {
  const a = sharp(path.join(dirA, f));
  const b = sharp(path.join(dirB, f));
  const [ma, mb] = await Promise.all([a.metadata(), b.metadata()]);
  if (ma.width !== mb.width || ma.height !== mb.height) {
    console.log(`${f}: 尺寸不同 ${ma.width}x${ma.height} vs ${mb.width}x${mb.height}`);
    allSame = false;
    continue;
  }
  const [ra, rb] = await Promise.all([
    a.raw().toBuffer(),
    b.raw().toBuffer(),
  ]);
  if (ra.length !== rb.length) {
    console.log(`${f}: 原始缓冲长度不同`);
    allSame = false;
    continue;
  }
  let diff = 0;
  for (let i = 0; i < ra.length; i += 4) {
    if (ra[i] !== rb[i] || ra[i + 1] !== rb[i + 1] || ra[i + 2] !== rb[i + 2] || ra[i + 3] !== rb[i + 3]) diff++;
  }
  const pct = ((diff / (ra.length / 4)) * 100).toFixed(4);
  if (diff > 0) allSame = false;
  worst = Math.max(worst, diff);
  console.log(`${f}: diff像素 ${diff} (${pct}%)`);
}
console.log(allSame ? "\n✅ 全部页面桌面像素零变化" : `\n⚠ 最大差异 ${worst} 像素`);
