// lib/qr.js —— 二维码封装（自包含，无外部依赖）

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const qrcodeFactory = require("./vendor/qrcode-generator.cjs");

/** 纠错等级：L/M/Q/H。M 在容错与尺寸间平衡，阿里云盘登录二维码用 M 已足够。 */
export const DEFAULT_ECC = "M";

/** 生成矩阵：{ count, isDark(row, col) }，便于测试与自定义渲染。 */
export function qrMatrix(text, { ecc = DEFAULT_ECC, typeNumber = 0 } = {}) {
  const qr = qrcodeFactory(typeNumber, ecc);
  qr.addData(String(text));
  qr.make();
  const count = qr.getModuleCount();
  return { count, isDark: (row, col) => qr.isDark(row, col) };
}

/** 生成独立 SVG（无外部引用、无 CSS 依赖），可直接嵌入 <img src="data:...">。 */
export function qrSvg(text, { ecc = DEFAULT_ECC, cellSize = 4, margin = 2, alt = "二维码" } = {}) {
  const qr = qrcodeFactory(0, ecc);
  qr.addData(String(text));
  qr.make();
  return qr.createSvgTag({ cellSize, margin, alt: { text: alt } });
}

/** data:URL 形式（默认 base64，避免中文/特殊字符转义问题）。 */
export default qrSvg;
