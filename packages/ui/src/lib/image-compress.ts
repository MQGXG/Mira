/**
 * 图片压缩（渲染进程 canvas 实现，零依赖）
 *
 * - 限制最大边 2000px
 * - 输出 JPEG，质量梯度 [0.85, 0.75, 0.6]，尝试压缩到 5MB base64 以内
 * - 原图已是小图时原样返回（不放大不重编码）
 */

export const MAX_IMAGE_DIMENSION = 2000;
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024; // 5MB base64

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

function estimateBase64Bytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const b64 = dataUrl.slice(comma + 1);
  return Math.floor((b64.length * 3) / 4);
}

/**
 * 压缩图片 data URL。
 * 返回压缩后的 data URL；若无需压缩则原样返回。
 */
export async function compressImage(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  const { width, height } = img;

  // 小图且未超限：原样返回（避免重编码损失质量）
  if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
    const bytes = estimateBase64Bytes(dataUrl);
    if (bytes <= MAX_IMAGE_BASE64_BYTES) return dataUrl;
  }

  const scale = Math.min(1, MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // 质量梯度尝试，找到 ≤5MB 的输出
  const qualities = [0.85, 0.75, 0.6, 0.45];
  for (const q of qualities) {
    const out = canvas.toDataURL("image/jpeg", q);
    if (estimateBase64Bytes(out) <= MAX_IMAGE_BASE64_BYTES) return out;
  }
  // 最低质量仍超限：返回最低质量结果（由上层决定是否接受）
  return canvas.toDataURL("image/jpeg", 0.45);
}
