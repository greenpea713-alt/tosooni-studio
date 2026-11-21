'use strict';
/* 토순이 친구 스튜디오
 * 올린 영상을 한 편씩 따로, 토순이 친구 편집 규칙대로 만든다. (규칙은 README.md)
 * 모든 처리는 브라우저 안에서: 캔버스로 합성하고 MediaRecorder로 녹화, 소리 다듬기와 형식 변환은 ffmpeg.wasm. */

// ================================================================ 규칙 (README의 '편집 규칙'과 같게 유지)
const RULE = {
  shortsMaxSec: 180,            // 이보다 길면 세로여도 1920×1080 일반 영상
  ivory: '#F7F3EC',
  fadeInFromIvory: 0.35,        // 인트로/타이틀 뒤 본편이 아이보리에서 열리는 시간
  fadeOutToIvory: 0.5,          // 가로 영상 끝
  shortsEndingXfade: 0.3,       // 쇼츠 본편 → 엔딩
  captionSec: 3.5,              // 도입부 자막이 떠 있는 시간
  targetLufs: -14,
  hissDropDb: 8,                // 노이즈 제거로 이만큼 이상 줄면 '잡음만 있는 소리'로 봄
  silentLufs: -50,
  audioFilter: 'adeclip,highpass=f=150,afftdn=nr=12:nf=-40',
};
const SIZE = { h: [1920, 1080], v: [1080, 1920] };

// ================================================================ assets
const A = 'assets/';
const ASSET = {
  opening: {
    intro4s:   { h: A + 'opening-intro4s.mp4' },
    official:  { h: A + 'opening-official.mp4' },
    botanical: { h: A + 'opening-botanical-16x9.mp4', v: A + 'opening-botanical-9x16.mp4' },
  },
  greenTitle: { h: A + 'title-16x9.mp4', v: A + 'title-9x16.mp4' },
  corner: { h: A + 'frame-corner-16x9.png', v: A + 'frame-corner-9x16.png' },
  wipe: { h: A + 'leaf-wipe-16x9.mp4', v: A + 'leaf-wipe-9x16.mp4', cut: 0.7 },
  ending: { v: A + 'ending-9x16.mp4' },
};
const pickSrc = (e, fmt) => e[fmt] || e.h || e.v;

// ================================================================ state
const state = {
  clips: [],
  theme: 'classic',
  opening: 'intro4s',
  ending: 'shorts',
  watermark: true, grade: true, frame: false,
  clean: true, muteHiss: true, normalize: true,
  running: false,
  // 카드 레이아웃 (세로 쇼츠를 크림 카드에 담기). 기본은 꺼짐 = 지금까지의 결과물 그대로.
  card: false, cardFrame: true, cardIcon: 'default', cardScale: 0.56,
  selected: null,   // {clipId, kind:'main'|'crop'} 미리보기 대상
};
let clipSeq = 0;
const $ = (id) => document.getElementById(id);
const screen = $('screen');
const sctx = screen.getContext('2d');

// ================================================================ helpers
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const prog = (t, a, b) => clamp((t - a) / (b - a));
const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const fmtTime = (s) => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error(src)); im.src = src; });
}
const imgCache = new Map();
const image = (src) => { if (!imgCache.has(src)) imgCache.set(src, loadImage(src)); return imgCache.get(src); };

// 숨겨진 보관함: 화면 밖 video를 문서에 붙여 두면 크롬이 디코딩을 멈추지 않는다
const shelf = document.createElement('div');
shelf.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;';
document.body.append(shelf);

function makeVideo(src, opts) { return makeMedia('video', src, opts); }
function makeMedia(tag, src, { muted = false } = {}) {
  return new Promise((res, rej) => {
    const v = document.createElement(tag);
    v.preload = 'auto'; v.playsInline = true; v.muted = muted; v.crossOrigin = 'anonymous';
    v.style.cssText = 'width:2px;height:2px';
    v.src = src;
    const done = () => { off(); res(v); };
    const fail = () => { off(); v.remove(); rej(new Error('영상을 열지 못했어요')); };
    const off = () => { v.removeEventListener('loadeddata', done); v.removeEventListener('error', fail); };
    v.addEventListener('loadeddata', done);
    v.addEventListener('error', fail);
    shelf.append(v);
    v.load();
  });
}
function dropVideo(v) { if (!v) return; v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }

// ================================================================ 그리기 도우미
function setFont(ctx, weight, px, ls) {
  ctx.font = `${weight} ${px}px "Noto Sans KR"`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = (ls || 0) + 'px';
}
function resetFont(ctx) { if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'; }
// letterSpacing은 글자 뒤에 붙어서 가운데 정렬이 오른쪽으로 밀린다 → 반만큼 보정
function centerText(ctx, txt, x, y, ls) { ctx.textAlign = 'center'; ctx.fillText(txt, x + (ls || 0) / 2, y); }
function fitPx(ctx, txt, weight, px, maxW, lsRatio) {
  let s = px;
  setFont(ctx, weight, s, s * lsRatio);
  while (ctx.measureText(txt).width > maxW && s > 18) { s -= 1; setFont(ctx, weight, s, s * lsRatio); }
  return s;
}
function heartPath(g, cx, cy, s) {
  g.beginPath(); g.moveTo(cx, cy + s * 0.9);
  g.bezierCurveTo(cx - s * 1.25, cy + s * 0.05, cx - s * 0.75, cy - s * 0.95, cx, cy - s * 0.38);
  g.bezierCurveTo(cx + s * 0.75, cy - s * 0.95, cx + s * 1.25, cy + s * 0.05, cx, cy + s * 0.9);
  g.closePath();
}

// 영상 배치. mode: 'cover'(꽉 채움) | 'contain'(가운데, 남는 곳은 아이보리) | {cropX}(세로 크롭)
function drawVideo(ctx, src, W, H, mode) {
  const vw = src.videoWidth, vh = src.videoHeight;
  if (!vw || !vh) return;
  if (mode === 'contain') {
    ctx.fillStyle = RULE.ivory; ctx.fillRect(0, 0, W, H);
    const s = Math.min(W / vw, H / vh), dw = vw * s, dh = vh * s;
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return;
  }
  const s = Math.max(W / vw, H / vh);
  const sw = W / s, sh = H / s;
  const cx = mode && typeof mode === 'object' ? mode.cropX : 0.5;
  const sx = (vw - sw) * clamp(cx), sy = (vh - sh) / 2;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
}
// 토순이 에셋(종이 배경)을 다른 비율에 놓을 때: 가장자리 색으로 채움
const edgeCv = document.createElement('canvas');
const edgeCtx = edgeCv.getContext('2d', { willReadFrequently: true });
function drawAsset(ctx, src, W, H) {
  const vw = src.videoWidth, vh = src.videoHeight;
  if (!vw || !vh) return;
  if (Math.abs(vw / vh - W / H) < 0.04) { ctx.drawImage(src, 0, 0, W, H); return; }
  const tall = H / W > vh / vw;           // 세로 화면에 가로 에셋 → 위아래를 채움
  // 채울 색: 맞닿는 가장자리(가로 에셋이면 윗줄)의 평균색
  edgeCv.width = 8; edgeCv.height = 8;
  if (tall) edgeCtx.drawImage(src, vw * 0.3, 0, vw * 0.4, vh * 0.03, 0, 0, 8, 8);
  else edgeCtx.drawImage(src, 0, vh * 0.3, vw * 0.03, vh * 0.4, 0, 0, 8, 8);
  const d = edgeCtx.getImageData(0, 0, 8, 1).data;
  let r = 0, g = 0, b = 0;
  for (let k = 0; k < d.length; k += 4) { r += d[k]; g += d[k + 1]; b += d[k + 2]; }
  const col = `${r / 8 | 0},${g / 8 | 0},${b / 8 | 0}`;
  ctx.fillStyle = `rgb(${col})`; ctx.fillRect(0, 0, W, H);
  // 가로 오프닝을 쇼츠에 놓을 땐 가운데 70%만 보이게 살짝 키움(양옆 여백만 잘림)
  const s = tall ? W / (vw * 0.7) : Math.min(W / vw, H / vh);
  const dw = vw * s, dh = vh * s, dx = (W - dw) / 2, dy = (H - dh) / 2;
  ctx.drawImage(src, dx, dy, dw, dh);
  // 이음새가 보이지 않게 경계를 부드럽게
  const f = (tall ? dh : dw) * 0.12;
  const grad = (x0, y0, x1, y1) => { const gr = ctx.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, `rgba(${col},1)`); gr.addColorStop(1, `rgba(${col},0)`); return gr; };
  if (tall) {
    ctx.fillStyle = grad(0, dy, 0, dy + f); ctx.fillRect(0, dy, W, f);
    ctx.fillStyle = grad(0, dy + dh, 0, dy + dh - f); ctx.fillRect(0, dy + dh - f, W, f);
  } else {
    ctx.fillStyle = grad(dx, 0, dx + f, 0); ctx.fillRect(dx, 0, f, H);
    ctx.fillStyle = grad(dx + dw, 0, dx + dw - f, 0); ctx.fillRect(dx + dw - f, 0, f, H);
  }
}

// TOSOONI 작은 로고 (가로: 오른쪽 위, 쇼츠: 위 가운데)
function drawWatermark(ctx, W, H, fmt, alpha) {
  const px = fmt === 'v' ? 30 : 24, ls = px * 0.42;
  ctx.save();
  ctx.globalAlpha = 0.82 * alpha;
  setFont(ctx, 300, px, ls);
  ctx.fillStyle = '#FFFDF9';
  ctx.shadowColor = 'rgba(30,25,20,0.35)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 1;
  ctx.textBaseline = 'alphabetic';
  if (fmt === 'v') centerText(ctx, 'TOSOONI', W / 2, H * 0.075, ls);
  else { ctx.textAlign = 'right'; ctx.fillText('TOSOONI', W - 56, 76); }
  ctx.restore();
  resetFont(ctx);
}
// 도입부 자막: 위쪽에 작게
function drawCaption(ctx, W, H, fmt, text, t, start = 0, dur = RULE.captionSec) {
  if (!text) return;
  const u = t - (start || 0), d = Math.max(0.8, dur || RULE.captionSec);
  const a = Math.min(prog(u, 0.25, 0.6), 1 - prog(u, d - 0.35, d));
  if (a <= 0) return;
  const vert = fmt === 'v';
  const px = fitPx(ctx, text, 400, vert ? 46 : 40, W * 0.84, 0.04);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = '#FFFDF9';
  ctx.shadowColor = 'rgba(20,18,15,0.55)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 2;
  ctx.textBaseline = 'alphabetic';
  centerText(ctx, text, W / 2, vert ? H * 0.135 : 150, px * 0.04);
  ctx.restore();
  resetFont(ctx);
}

// ---------------------------------------------------------------- 카드 레이아웃 (크림 카드 + 동그란 프로필 + 제목 + 영상 + 자막)
// 사용자가 좋아하는 '카드형 쇼츠' 모양. state.card 가 켜졌고 세로 결과물일 때만 쓴다.
const CARD = { paper: '#FAF6EE', panel: '#FFFCF6', ink: '#2F2E2B', sub: '#5A554D', line: '#E7DFD2', footer: '#8E8B85' };
function roundRectPath(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}
// 카드 안 자리 — 그리기와 미리보기 편집 상자가 같은 값을 쓰도록 한 곳에서 계산
function cardLayout(W, H, clip, kind) {
  const pad = Math.round(W * 0.045), inset = Math.round(W * 0.030);
  const innerX = pad + inset, innerW = W - innerX * 2;
  const hasIcon = state.cardIcon !== 'none';
  const iconR = Math.round(W * 0.062);
  const iconCy = pad + Math.round(H * 0.030) + iconR;
  const titlePx = Math.round(W * 0.050);
  const topOfTitle = hasIcon ? iconCy + iconR + Math.round(H * 0.018) : pad + Math.round(H * 0.048);
  const titleY = Math.round(topOfTitle + titlePx * 0.78);
  const videoTop = titleY + Math.round(H * 0.035);
  const captionPx = Math.round(W * 0.042);
  const footerY = H - Math.round(H * 0.062);
  const captionY = footerY - Math.round(H * 0.140);
  const availH = Math.max(Math.round(H * 0.2), captionY - captionPx - Math.round(H * 0.010) - videoTop);
  const srcW = kind === 'crop' ? 9 : (clip && clip.w ? clip.w : 9);
  const srcH = kind === 'crop' ? 16 : (clip && clip.h ? clip.h : 16);
  let vw = Math.min(innerW, Math.round(W * clamp(state.cardScale, 0.3, 0.95)));
  let vh = Math.round(vw * srcH / srcW);
  if (vh > availH) { vh = availH; vw = Math.round(vh * srcW / srcH); }
  vw = Math.max(1, vw); vh = Math.max(1, vh);
  return {
    pad, radius: Math.round(W * 0.032), hasIcon, iconR, iconCy,
    title: { y: titleY, px: titlePx, maxW: W * 0.80 },
    video: { x: Math.round((W - vw) / 2), y: videoTop, w: vw, h: vh },
    caption: { y: captionY, px: captionPx, maxW: W * 0.80 },
    footerY,
  };
}
// 프로필 사진: 기본은 앱의 동그란 토순이 아이콘, 사진을 고르면 그 사진을 동그랗게
const cardIconCache = { src: '', img: null };
function cardIconImage() {
  const src = state.cardIcon;
  if (typeof src !== 'string' || !src || src === 'default' || src === 'none') return null;
  if (cardIconCache.src !== src) {
    const im = new Image();
    im.onload = () => { try { if (!state.running) drawStill(); } catch (e) {} };
    im.src = src;
    cardIconCache.src = src; cardIconCache.img = im;
  }
  return cardIconCache.img;
}
function drawCardBase(g, W, H) {
  g.fillStyle = CARD.paper; g.fillRect(0, 0, W, H);
  if (!state.cardFrame) return;
  const pad = Math.round(W * 0.045), r = Math.round(W * 0.032);
  g.save();
  g.shadowColor = 'rgba(92,78,62,0.13)';
  g.shadowBlur = Math.round(W * 0.030);
  g.shadowOffsetY = Math.round(W * 0.008);
  roundRectPath(g, pad, pad, W - pad * 2, H - pad * 2, r);
  g.fillStyle = CARD.panel; g.fill();
  g.restore();
  g.save();
  roundRectPath(g, pad, pad, W - pad * 2, H - pad * 2, r);
  g.strokeStyle = CARD.line; g.lineWidth = Math.max(1, W * 0.0013); g.stroke();
  g.restore();
}
function drawCardIcon(g, cx, cy, r) {
  if (state.cardIcon === 'none') return;
  const img = cardIconImage();
  if (img && img.complete && img.naturalWidth) {
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
    const s = Math.max((r * 2) / img.naturalWidth, (r * 2) / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    g.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
    g.restore();
    g.beginPath(); g.arc(cx, cy, r - Math.max(1, r * 0.02), 0, Math.PI * 2);
    g.strokeStyle = 'rgba(191,163,115,0.6)'; g.lineWidth = Math.max(1, r * 0.035); g.stroke();
    return;
  }
  drawTosooniIcon(g, cx, cy, r);
}
function drawCardText(g, text, y, px, weight, clampW, color) {
  const s = String(text || '').trim();
  if (!s) return;
  const lsR = 0.03;
  const size = fitPx(g, s, weight, px, clampW, lsR);
  g.fillStyle = color; g.textBaseline = 'alphabetic';
  centerText(g, s, g.canvas ? g.canvas.width / 2 : 0, y, size * lsR);
  resetFont(g);
}
// 카드 한 장 그리기: 배경·테두리 → 프로필 → 제목 → 영상 → 자막 → TOSOONI
function drawCard(g, W, H, clip, el, caption, kind) {
  const L = cardLayout(W, H, clip, kind);
  drawCardBase(g, W, H);
  drawCardIcon(g, W / 2, L.iconCy, L.iconR);
  drawCardText(g, clip.title, L.title.y, L.title.px, 500, L.title.maxW, CARD.ink);
  const box = L.video;
  if (el && el.videoWidth) {
    g.save();
    roundRectPath(g, box.x, box.y, box.w, box.h, Math.round(box.w * 0.045));
    g.clip();
    if (state.grade && 'filter' in g) g.filter = 'sepia(0.07) saturate(1.04) brightness(1.01)';
    g.translate(box.x, box.y);
    drawVideo(g, el, box.w, box.h, kind === 'crop' ? { cropX: clip.cropX } : 'cover');
    g.filter = 'none';
    g.restore();
    g.save();
    roundRectPath(g, box.x, box.y, box.w, box.h, Math.round(box.w * 0.045));
    g.strokeStyle = 'rgba(60,52,44,0.10)'; g.lineWidth = Math.max(1, W * 0.0015); g.stroke();
    g.restore();
  }
  drawCardText(g, caption, L.caption.y, L.caption.px, 400, L.caption.maxW, CARD.sub);
  if (state.watermark) {
    const px = Math.max(10, Math.round(W * 0.024)), ls = px * 0.45;
    setFont(g, 300, px, ls);
    g.fillStyle = CARD.footer; g.textBaseline = 'alphabetic';
    centerText(g, 'TOSOONI', W / 2, L.footerY, ls);
    resetFont(g);
  }
}

// ---------------------------------------------------------------- 클래식 타이틀 카드 (아이보리 종이, 골드 선, 작은 하트)
const papers = new Map();
function paperTexture(W, H, color = RULE.ivory) {
  const key = W + 'x' + H + color;
  if (papers.has(key)) return papers.get(key);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, W, H);   // 매끈한 단색 배경 (종이 얼룩·노이즈 없음)
  papers.set(key, c); return c;
}
const CLASSIC_TITLE_SEC = 3.6;
function drawClassicTitle(ctx, W, H, fmt, text, t) {
  ctx.drawImage(paperTexture(W, H), 0, 0);
  const vert = fmt === 'v';
  const k = W / (vert ? 1080 : 1920) * (vert ? 1.15 : 1);
  const cx = W / 2, yc = H * (vert ? 0.46 : 0.5);
  const out = 1 - prog(t, CLASSIC_TITLE_SEC - 0.4, CLASSIC_TITLE_SEC - 0.1);   // 끝에서 아이보리로 비움
  // 골드 실선 + 하트
  const lp = easeOut(prog(t, 0.25, 0.95)), half = 110 * k * lp, hy = yc - 92 * k;
  ctx.save();
  ctx.globalAlpha = out;
  if (lp > 0) {
    ctx.strokeStyle = '#BFA373'; ctx.lineWidth = 1.5 * k;
    ctx.beginPath(); ctx.moveTo(cx - 22 * k, hy); ctx.lineTo(cx - 22 * k - half, hy); ctx.moveTo(cx + 22 * k, hy); ctx.lineTo(cx + 22 * k + half, hy); ctx.stroke();
  }
  const ha = prog(t, 0.55, 0.8);
  if (ha > 0) { ctx.globalAlpha = out * ha; ctx.fillStyle = '#E8A3AE'; heartPath(ctx, cx, hy - 1, 11 * k * (0.85 + 0.15 * easeOut(ha))); ctx.fill(); }
  ctx.textBaseline = 'alphabetic';
  const ta = ease(prog(t, 0.7, 1.3));
  const ma = ease(prog(t, 0.8, 1.6));
  if (ma > 0 && text) {
    ctx.globalAlpha = out * ma;
    const lsR = 0.08 + 0.12 * (1 - ma);
    const px = fitPx(ctx, text, 300, 84 * k, W * (vert ? 0.84 : 0.66), lsR);
    ctx.fillStyle = '#2F2E2B';
    centerText(ctx, text, cx, yc + 30 * k + (1 - ma) * 10, px * lsR);
  }
  const fa = ease(prog(t, 1.25, 1.85));
  if (fa > 0) { ctx.globalAlpha = out * fa; setFont(ctx, 400, 21 * k, 21 * k * 0.38); ctx.fillStyle = '#BFA373'; centerText(ctx, '토순이 친구', cx, yc + 120 * k, 21 * k * 0.38); }
  ctx.restore();
  resetFont(ctx);
}

// ---------------------------------------------------------------- 클래식 전환 카드: 매끈한 아이보리 + 가운데 작은 동그란 토순이 아이콘
const ICON_CARD_SEC = 1.4;
function drawTosooniIcon(g, cx, cy, r) {
  g.save();
  g.fillStyle = '#EBDCD5'; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();          // 블러시 동그라미
  g.strokeStyle = '#BFA373'; g.lineWidth = Math.max(1, r * 0.035); g.stroke();                  // 얇은 골드 테
  g.beginPath(); g.arc(cx, cy, r * 0.97, 0, Math.PI * 2); g.clip();
  const f = r * 0.42, fy = cy + r * 0.08;
  g.fillStyle = '#4A4845';                                                                       // 차콜 롭이어
  for (const d of [-1, 1]) { g.beginPath(); g.ellipse(cx + d * f * 0.95, fy + f * 0.25, f * 0.36, f * 0.85, d * 0.35, 0, Math.PI * 2); g.fill(); }
  g.beginPath(); g.ellipse(cx, fy - f * 0.12, f * 0.92, f * 0.8, 0, 0, Math.PI * 2); g.fill();    // 머리
  g.fillStyle = '#F7F3EC'; g.beginPath(); g.ellipse(cx, fy + f * 0.14, f * 0.66, f * 0.54, 0, 0, Math.PI * 2); g.fill();   // 크림 얼굴
  g.fillStyle = '#2F2E2B';
  for (const d of [-1, 1]) { g.beginPath(); g.arc(cx + d * f * 0.3, fy + f * 0.02, f * 0.075, 0, Math.PI * 2); g.fill(); }   // 눈
  g.fillStyle = '#E8A3AE'; heartPath(g, cx, fy + f * 0.2, f * 0.1); g.fill();                  // 핑크 코
  g.restore();
}
function drawIconCard(ctx, W, H, fmt, text, t) {
  ctx.drawImage(paperTexture(W, H), 0, 0);
  const k = W / (fmt === 'v' ? 1080 : 1920);
  const a = ease(prog(t, 0.1, 0.45)) * (1 - ease(prog(t, ICON_CARD_SEC - 0.4, ICON_CARD_SEC - 0.08)));
  if (a <= 0) return;
  ctx.save(); ctx.globalAlpha = a;
  drawTosooniIcon(ctx, W / 2, H / 2, 46 * k * (fmt === 'v' ? 1.3 : 1) * (0.94 + 0.06 * a));
  ctx.restore();
}

// ---------------------------------------------------------------- 미니멀 인트로: 매끈한 아이보리 · 얇은 골드 호 · 작은 토순이 · 하트 하나 · TOSOONI
const MINIMAL_SEC = 3.4;
function drawMinimalIntro(ctx, W, H, fmt, text, t) {
  ctx.drawImage(paperTexture(W, H), 0, 0);
  const vert = fmt === 'v', k = W / (vert ? 1080 : 1920) * (vert ? 1.25 : 1);
  const cx = W / 2, cy = H * (vert ? 0.45 : 0.42);
  const out = 1 - ease(prog(t, MINIMAL_SEC - 0.5, MINIMAL_SEC - 0.06));
  const R = 112 * k;
  ctx.save(); ctx.globalAlpha = out;
  // 얇은 골드 호: 꼭대기(하트 자리)를 비워 두고 양옆으로 천천히 그려짐
  const lp = easeOut(prog(t, 0.15, 1.2));
  if (lp > 0) {
    ctx.strokeStyle = '#BFA373'; ctx.lineWidth = 1.3 * k; ctx.lineCap = 'round';
    const gap = 0.045 * Math.PI, sweep = 0.36 * Math.PI * lp;
    ctx.beginPath(); ctx.arc(cx, cy, R, 1.5 * Math.PI - gap - sweep, 1.5 * Math.PI - gap); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R, 1.5 * Math.PI + gap, 1.5 * Math.PI + gap + sweep); ctx.stroke();
  }
  const ha = prog(t, 0.95, 1.35);
  if (ha > 0) { ctx.globalAlpha = out * ha; ctx.fillStyle = '#E8A3AE'; heartPath(ctx, cx, cy - R, 7 * k * (0.8 + 0.2 * easeOut(ha))); ctx.fill(); }
  const ra = ease(prog(t, 0.5, 1.2));
  if (ra > 0) { ctx.globalAlpha = out * ra; drawTosooniIcon(ctx, cx, cy + (1 - ra) * 6 * k, 66 * k); }
  ctx.textBaseline = 'alphabetic';
  const la = ease(prog(t, 1.15, 1.85));
  if (la > 0) { ctx.globalAlpha = out * la; const px = 38 * k, ls = px * 0.5; setFont(ctx, 300, px, ls); ctx.fillStyle = '#2F2E2B'; centerText(ctx, 'TOSOONI', cx, cy + R + 64 * k + (1 - la) * 6 * k, ls); }
  const sa = ease(prog(t, 1.45, 2.05));
  if (sa > 0) { ctx.globalAlpha = out * sa; const px = 16 * k, ls = px * 0.5; setFont(ctx, 400, px, ls); ctx.fillStyle = '#BFA373'; centerText(ctx, '토순이 친구', cx, cy + R + 102 * k, ls); }
  ctx.restore(); resetFont(ctx);
}

// ---------------------------------------------------------------- 가을 테마 (단풍잎·은행잎 페이퍼컷, 크림 종이)
const AUTUMN = {
  paper: '#F4ECDF', ink: '#3B2F27', gold: '#B0894A', sub: '#8C7B6B',
  maple: ['#B4492E', '#C4613A', '#A53F2C', '#CC7A40'],
  ginkgo: ['#D6A63C', '#E0B754', '#C8972F'],
  titleSec: 3.8, transSec: 1.4, transCut: 0.7,
};
const aRng = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const spriteCache = new Map();
// 잎 하나를 256px 캔버스에 그려 둠 (가운데가 잎 중심, 반지름 약 100)
function leafSprite(type, color) {
  const key = type + color;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.translate(128, 128); g.scale(100, 100);
  g.beginPath();
  if (type === 'maple') {
    const lobes = [[-90, 1], [-32, 0.88], [28, 0.62], [152, 0.62], [-148, 0.88]].map(([a, l]) => [a * Math.PI / 180, l]);
    const pt = (a, r) => [Math.cos(a) * r, Math.sin(a) * r];
    let first = true;
    lobes.forEach(([a, l], i) => {
      const [na] = lobes[(i + 1) % lobes.length];
      let mid = (a + (na < a ? na + Math.PI * 2 : na)) / 2;
      const deep = Math.abs(((mid * 180 / Math.PI) % 360) - 90) < 30 ? 0.22 : 0.34;   // 줄기 쪽은 더 깊게
      const pts = [pt(a - 0.3, l * 0.6), pt(a - 0.16, l * 0.78), pt(a - 0.08, l * 0.72), pt(a, l), pt(a + 0.08, l * 0.72), pt(a + 0.16, l * 0.78), pt(a + 0.3, l * 0.6), pt(mid, deep)];
      pts.forEach(([x, y]) => { if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y); });
    });
    g.closePath();
  } else {
    // 은행잎: 부채꼴, 위 가운데가 살짝 갈라짐
    const cy = 0.55, R = 1.05, a0 = -Math.PI / 2 - 0.95, a1 = -Math.PI / 2 + 0.95;
    g.moveTo(0, cy - 0.05);
    g.quadraticCurveTo(-0.25, cy - 0.35, Math.cos(a0) * R, cy + Math.sin(a0) * R);
    g.arc(0, cy, R, a0, -Math.PI / 2 - 0.06);
    g.lineTo(0, cy - R * 0.78);
    g.lineTo(Math.cos(-Math.PI / 2 + 0.06) * R, cy + Math.sin(-Math.PI / 2 + 0.06) * R);
    g.arc(0, cy, R, -Math.PI / 2 + 0.06, a1);
    g.quadraticCurveTo(0.25, cy - 0.35, 0, cy - 0.05);
    g.closePath();
  }
  g.save();
  g.shadowColor = 'rgba(60,35,20,0.28)'; g.shadowBlur = 6 / 100 * 100; g.shadowOffsetY = 0.03;
  g.fillStyle = color; g.fill();
  g.restore();
  g.save(); g.clip();
  g.fillStyle = 'rgba(255,255,255,0.14)'; g.fillRect(-1.2, -1.2, 1.2, 2.4);   // 종이 한쪽 결
  g.strokeStyle = 'rgba(255,240,215,0.35)'; g.lineWidth = 0.018;
  if (type === 'maple') {
    for (const a of [-90, -32, 28, 152, -148]) { const r = a * Math.PI / 180; g.beginPath(); g.moveTo(0, 0.1); g.lineTo(Math.cos(r) * 0.8, Math.sin(r) * 0.8); g.stroke(); }
  } else {
    for (let i = -6; i <= 6; i++) { const r = -Math.PI / 2 + i * 0.14; g.beginPath(); g.moveTo(0, 0.5); g.lineTo(Math.cos(r) * 1.0, 0.55 + Math.sin(r) * 1.0); g.stroke(); }
  }
  g.restore();
  // 줄기
  g.strokeStyle = color; g.lineWidth = 0.05; g.lineCap = 'round';
  g.beginPath();
  if (type === 'maple') { g.moveTo(0, 0.15); g.quadraticCurveTo(0.04, 0.5, 0.1, 0.78); }
  else { g.moveTo(0, 0.5); g.quadraticCurveTo(0.03, 0.75, 0.08, 0.98); }
  g.stroke();
  spriteCache.set(key, c);
  return c;
}
function drawLeaf(ctx, L, x, y, size, rot, alpha = 1) {
  const sp = leafSprite(L.type, L.color);
  ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y); ctx.rotate(rot);
  const s = size / 200; ctx.drawImage(sp, -128 * s, -128 * s, 256 * s, 256 * s);
  ctx.restore();
}
function pickLeaf(r) {
  const type = r() < 0.55 ? 'maple' : 'ginkgo';
  const pal = AUTUMN[type];
  return { type, color: pal[Math.floor(r() * pal.length)] };
}
// 바닥에 내려앉은 낙엽 배치 (화면 아래 가장자리, 일부는 화면 밖으로 잘림)
function fallenLayout(W, H, seed, n, band) {
  const r = aRng(seed), k = Math.min(W, H) / 1080, out = [];
  for (let i = 0; i < n; i++) {
    const L = pickLeaf(r);
    const x = (i + 0.2 + r() * 0.6) / n * W;
    out.push({ ...L, x, y: H - r() * band * k + 30 * k, size: (90 + r() * 70) * k, rot: (r() - 0.5) * 2.6, delay: 0.15 + r() * 0.7 });
  }
  return out;
}
const stepT = (t) => Math.floor(t * 12) / 12;     // 종이 인형처럼 12fps로 끊어 움직임
function drawAutumnTitle(ctx, W, H, fmt, text, t) {
  ctx.drawImage(paperTexture(W, H, AUTUMN.paper), 0, 0);
  const vert = fmt === 'v', k = W / (vert ? 1080 : 1920) * (vert ? 1.15 : 1);
  const ts = stepT(t);
  // 바닥 낙엽: 위에서 툭 떨어져 자리 잡음
  for (const L of fallenLayout(W, H, 11, vert ? 7 : 11, vert ? 120 : 90)) {
    const p = clamp((ts - L.delay) / 0.35);
    if (p <= 0) continue;
    drawLeaf(ctx, L, L.x, L.y - (1 - easeOut(p)) * 60, L.size, L.rot + (1 - p) * 0.6, p);
  }
  // 위 오른쪽 구석에 작게 두 장
  const r = aRng(5);
  [[W - 70 * k, 40 * k], [W - 170 * k, -10 * k]].forEach(([x, y], i) => {
    const p = clamp((ts - 0.5 - i * 0.15) / 0.3); if (p <= 0) return;
    drawLeaf(ctx, pickLeaf(r), x, y, (95 - i * 15) * k, 2.4 + i, p);
  });
  // 천천히 떨어지는 한 장
  const fall = (t % 3.8) / 3.8;
  drawLeaf(ctx, { type: 'ginkgo', color: AUTUMN.ginkgo[1] }, W * ((vert ? 0.8 : 0.84) + Math.sin(fall * 6) * 0.03), -60 * k + fall * H * (vert ? 0.3 : 0.75), 70 * k, Math.sin(ts * 2) * 0.7, clamp(fall * 6) * (1 - clamp((fall - 0.85) * 7)));
  // 글씨 (클래식과 같은 자리, 따뜻한 잉크색)
  const cx = W / 2, yc = H * (vert ? 0.44 : 0.46);
  const out = 1 - prog(t, AUTUMN.titleSec - 0.35, AUTUMN.titleSec);
  ctx.save(); ctx.globalAlpha = out; ctx.textBaseline = 'alphabetic';
  const lp = easeOut(prog(t, 0.25, 0.95)), half = 110 * k * lp, hy = yc - 92 * k;
  if (lp > 0) { ctx.strokeStyle = AUTUMN.gold; ctx.lineWidth = 1.5 * k; ctx.beginPath(); ctx.moveTo(cx - 22 * k, hy); ctx.lineTo(cx - 22 * k - half, hy); ctx.moveTo(cx + 22 * k, hy); ctx.lineTo(cx + 22 * k + half, hy); ctx.stroke(); }
  const ha = prog(ts, 0.55, 0.8);
  if (ha > 0) { ctx.globalAlpha = out * ha; drawLeaf(ctx, { type: 'maple', color: AUTUMN.maple[1] }, cx, hy, 30 * k, 0.15); }
  const ma = ease(prog(t, 0.8, 1.6));
  if (ma > 0 && text) { ctx.globalAlpha = out * ma; const lsR = 0.08 + 0.12 * (1 - ma); const px = fitPx(ctx, text, 300, 84 * k, W * (vert ? 0.84 : 0.66), lsR); ctx.fillStyle = AUTUMN.ink; centerText(ctx, text, cx, yc + 30 * k + (1 - ma) * 10, px * lsR); }
  const fa = ease(prog(t, 1.25, 1.85));
  if (fa > 0) { ctx.globalAlpha = out * fa; setFont(ctx, 400, 21 * k, 21 * k * 0.38); ctx.fillStyle = AUTUMN.gold; centerText(ctx, '토순이 친구', cx, yc + 120 * k, 21 * k * 0.38); }
  ctx.restore(); resetFont(ctx);
}
// 낙엽 전환: 잎들이 비스듬히 쏟아지며 화면을 덮었다가(크림색) 걷힘. cut 지점에서 완전히 가려짐
function drawAutumnTransition(ctx, W, H, t) {
  const D = AUTUMN.transSec, C = AUTUMN.transCut;
  if (t < 0 || t > D) return;
  const cover = t < C ? easeOut(prog(t, C - 0.35, C)) : 1 - ease(prog(t, C + 0.05, C + 0.5));
  if (cover > 0) { ctx.save(); ctx.globalAlpha = cover; ctx.drawImage(paperTexture(W, H, AUTUMN.paper), 0, 0); ctx.restore(); }
  const r = aRng(23), k = Math.min(W, H) / 1080, n = 34, ts = stepT(t);
  for (let i = 0; i < n; i++) {
    const L = pickLeaf(r);
    const st = r() * 0.55, life = 0.75 + r() * 0.2;
    const p = (ts - st) / life;
    if (p <= 0 || p >= 1) continue;
    const x0 = (r() * 1.4 - 0.5) * W, x = x0 + p * W * 0.45;
    const y = -0.15 * H + p * H * 1.3 + Math.sin(p * 8 + i) * 20 * k;
    drawLeaf(ctx, L, x, y, (110 + r() * 110) * k, r() * 6 + p * (r() < .5 ? 3 : -3));
  }
}
// 본편 위 낙엽 테두리: 아래 양쪽 구석에만 조금
const frameCache = new Map();
function autumnFrame(W, H) {
  const key = W + 'x' + H;
  if (frameCache.has(key)) return frameCache.get(key);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), r = aRng(31), k = Math.min(W, H) / 1080;
  const spots = [[0.02, 0.98, 150], [0.09, 1.0, 120], [-0.01, 0.9, 110], [0.15, 1.02, 95], [0.06, 0.93, 80], [0.98, 1.0, 130], [0.91, 1.02, 100], [1.0, 0.93, 90]];
  for (const [fx, fy, sz] of spots) drawLeaf(g, pickLeaf(r), fx * W, fy * H, sz * k, r() * 6);
  frameCache.set(key, c);
  return c;
}

// 보태니컬(초록) 타이틀: 템플릿 영상 위에 큰 글씨만 얹음 (botanical-template-source.html과 같은 위치)
function drawGreenTitleText(ctx, W, H, fmt, text, t) {
  if (!text) return;
  const vert = fmt === 'v', k = W / (vert ? 720 : 1280), lw = W / k, lh = H / k;
  const ma = ease(prog(t, 1.2, 2.0));
  if (ma <= 0) return;
  ctx.save(); ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.globalAlpha = ma; ctx.textBaseline = 'alphabetic';
  const lsR = 0.1 + 0.18 * (1 - ma);
  const px = fitPx(ctx, text, 300, 62, vert ? lw * 0.76 : lw * 0.58, lsR);
  ctx.fillStyle = '#F5EFE3';
  centerText(ctx, text, lw / 2, lh * (vert ? 0.47 : 0.5) + 44 + (1 - ma) * 10, px * lsR);
  ctx.restore(); resetFont(ctx);
}

// ================================================================ 블루스크린 키잉 (잎 전환)
class Keyer {
  constructor() {
    this.c = document.createElement('canvas');
    const gl = this.gl = this.c.getContext('webgl', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true });
    if (!gl) { this.c2 = this.c.getContext('2d', { willReadFrequently: true }); return; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec2 p;varying vec2 v;void main(){v=p*0.5+0.5;gl_Position=vec4(p,0.,1.);}'));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, `precision mediump float;varying vec2 v;uniform sampler2D u;
      void main(){vec4 c=texture2D(u,v);float m=max(c.r,c.g);float d=c.b-m;float a=1.0-smoothstep(0.16,0.5,d);
      vec3 col=c.rgb;col.b=min(col.b,m+0.05);gl_FragColor=vec4(col*a,a);}`));
    gl.linkProgram(pr); gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    for (const [p, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }
  key(video) {
    const w = video.videoWidth, h = video.videoHeight;
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; }
    const gl = this.gl;
    if (gl) {
      gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return this.c;
    }
    const g = this.c2; g.drawImage(video, 0, 0, w, h);
    const im = g.getImageData(0, 0, w, h), d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const m = Math.max(d[i], d[i + 1]) / 255, b = d[i + 2] / 255, x = clamp((b - m - 0.16) / 0.34);
      d[i + 2] = Math.min(b, m + 0.05) * 255; d[i + 3] = (1 - x * x * (3 - 2 * x)) * 255;
    }
    g.putImageData(im, 0, 0); return this.c;
  }
}
let keyer = null;

// ================================================================ 음량 (ITU-R BS.1770 근사)
let audioCtx = null;
const getAudioCtx = () => (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());
async function lufsOfBuffer(ab) {
  const audio = await getAudioCtx().decodeAudioData(ab);
  const sr = audio.sampleRate;
  const oac = new OfflineAudioContext(audio.numberOfChannels, audio.length, sr);
  const src = oac.createBufferSource(); src.buffer = audio;
  const shelfF = oac.createBiquadFilter(); shelfF.type = 'highshelf'; shelfF.frequency.value = 1681.97; shelfF.gain.value = 4.0;
  const hp = oac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38.13; hp.Q.value = 0.5;
  src.connect(shelfF).connect(hp).connect(oac.destination); src.start();
  const out = await oac.startRendering();
  const block = Math.round(sr * 0.4), step = Math.round(sr * 0.1);
  const chans = []; for (let c = 0; c < Math.min(out.numberOfChannels, 2); c++) chans.push(out.getChannelData(c));
  const zs = [];
  for (let s = 0; s + block <= out.length; s += step) {
    let sum = 0;
    for (const ch of chans) { let acc = 0; for (let i = s; i < s + block; i++) acc += ch[i] * ch[i]; sum += acc / block; }
    zs.push(sum);
  }
  const L = (z) => -0.691 + 10 * Math.log10(z);
  const abs = zs.filter((z) => z > 0 && L(z) > -70);
  if (!abs.length) return -99;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((z) => L(z) > rel);
  if (!gated.length) return -99;
  // 모노는 재생할 때 양쪽으로 똑같이 나가므로 +3dB
  return L(gated.reduce((a, b) => a + b, 0) / gated.length) + (out.numberOfChannels === 1 ? 3.01 : 0);
}
const lufsCache = new Map();
function lufsOfUrl(url) {
  if (!lufsCache.has(url)) lufsCache.set(url, fetch(url).then((r) => r.arrayBuffer()).then(lufsOfBuffer).catch(() => null));
  return lufsCache.get(url);
}
const gainFor = (lufs) => (lufs == null || lufs < -90 ? 1 : clamp(Math.pow(10, (RULE.targetLufs - lufs) / 20), 0.05, 20));

// ================================================================ 준비: 소리 다듬기 + 형식 변환 (ffmpeg.wasm)
let ffmpegP = null;
function loadFFmpeg() {
  if (!ffmpegP) ffmpegP = (async () => {
    await new Promise((res, rej) => {
      const sc = document.createElement('script'); sc.src = 'vendor/ffmpeg/ffmpeg.js';
      sc.onload = res; sc.onerror = () => rej(new Error('변환 도구를 불러오지 못했어요')); document.head.append(sc);
    });
    const ff = new FFmpegWASM.FFmpeg();
    const base = new URL('vendor/ffmpeg/', location.href).href;
    await ff.load({ coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm' });
    return ff;
  })().catch((e) => { ffmpegP = null; throw e; });
  return ffmpegP;
}
let prepQueue = Promise.resolve();

function setClipNote(clip, txt) { clip.note = txt; if (clip.noteEl) { clip.noteEl.textContent = txt; clip.noteEl.hidden = !txt; } }

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

// 업로드 직후 뒤에서 돈다. 원본이 재생되면 바로 '준비됨'이고, 소리 다듬기는 끝나는 대로 붙는다.
async function prepareClip(clip) {
  if (!state.clips.includes(clip)) return;
  const needVideo = !clip.w;          // 화면을 못 읽는 형식(HEVC 등)
  const fail = (msg) => {
    clip.prepFinished = true;
    if (needVideo) { clip.status = 'failed'; setClipNote(clip, '이 영상은 이 브라우저에서 읽지 못했어요. 휴대폰에서 "호환성 우선"(H.264)으로 저장해 다시 올려 주세요.'); }
    else { clip.audio = null; setClipNote(clip, '소리 다듬기를 못 해서 원래 소리로 만들어요' + (msg ? ` (${msg})` : '')); }
  };
  let ff;
  try {
    setClipNote(clip, '편집 도구를 불러오는 중… (처음 한 번 30MB)');
    ff = await withTimeout(loadFFmpeg(), 120000, '불러오기 시간 초과');
  } catch (e) { console.error(e); fail(e.message); return; }

  const dir = '/m' + clip.id;
  let lastProg = 0;
  const onProg = ({ progress }) => { lastProg = progress; };
  ff.on('progress', onProg);
  const tick = setInterval(() => { if (clip.stage) setClipNote(clip, `${clip.stage} ${Math.round(clamp(lastProg) * 100)}%`); }, 400);
  try {
    // 원본을 메모리에 통째로 복사하지 않고 그대로 읽게 연결 (큰 영상·아이폰 대비)
    await ff.createDir(dir);
    await ff.mount('WORKERFS', { files: [clip.origFile] }, dir);
    const inPath = dir + '/' + clip.origFile.name;
    clip.stage = '소리 다듬는 중…'; lastProg = 0;
    const rc = await ff.exec(['-i', inPath, '-vn', '-filter_complex', `[0:a:0]asplit[a][b];[b]${RULE.audioFilter}[c]`,
      '-map', '[a]', '-ar', '48000', '-c:a', 'pcm_s16le', 'raw.wav', '-map', '[c]', '-ar', '48000', '-c:a', 'pcm_s16le', 'clean.wav']);
    if (rc === 0) {
      clip.stage = '소리 확인하는 중…';
      const raw = await ff.readFile('raw.wav'), wav = await ff.readFile('clean.wav');
      await ff.deleteFile('raw.wav').catch(() => {});
      const rawL = await lufsOfBuffer(raw.buffer.slice(0)), cleanL = await lufsOfBuffer(wav.buffer.slice(0));
      const hissOnly = rawL < RULE.silentLufs || rawL - cleanL >= RULE.hissDropDb;
      clip.audio = { rawLufs: rawL, cleanLufs: cleanL, hissOnly };
      if (!needVideo) clip.cleanAudio = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    } else clip.audio = { none: true };

    if (needVideo) {
      clip.stage = '읽을 수 있는 형식으로 바꾸는 중…'; lastProg = 0;
      const vArgs = ['-vf', "scale=trunc(iw*sar/2)*2:ih,setsar=1,scale='if(gte(iw,ih),min(1920,iw),-2)':'if(gte(iw,ih),-2,min(1920,ih))',fps=30,format=yuv420p", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18'];
      const args = clip.audio.none
        ? ['-i', inPath, '-map', '0:v:0', ...vArgs, '-movflags', '+faststart', 'out.mp4']
        : ['-i', inPath, '-i', 'clean.wav', '-map', '0:v:0', '-map', '1:a:0', ...vArgs, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'out.mp4'];
      if ((await ff.exec(args)) !== 0) throw new Error('변환 실패');
      const data = await ff.readFile('out.mp4');
      const url = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      const v = await makeVideo(url, { muted: true });
      if (!v.videoWidth) throw new Error('화면을 읽지 못했어요');
      v.currentTime = Math.min(1, v.duration / 3);
      await new Promise((r) => { v.onseeked = r; setTimeout(r, 1500); });
      dropVideo(clip.thumb);
      Object.assign(clip, { url, w: v.videoWidth, h: v.videoHeight, dur: v.duration, thumb: v, embeddedClean: !clip.audio.none, status: 'ready' });
    }
    setClipNote(clip, clip.audio.none ? '원본에 소리가 없어요'
      : clip.audio.hissOnly ? '잡음만 있는 소리라 원음을 끌게요' : '소리 다듬기 완료');
  } catch (e) {
    console.error(e); fail(e.message);
  } finally {
    clip.prepFinished = true;
    clearInterval(tick); clip.stage = null; ff.off('progress', onProg);
    for (const f of ['raw.wav', 'clean.wav', 'out.mp4']) await ff.deleteFile(f).catch(() => {});
    await ff.unmount(dir).catch(() => {}); await ff.deleteDir(dir).catch(() => {});
    renderClipList(); refresh();
  }
}

// ================================================================ 결과물 목록 (규칙 적용)
// 한 클립에서: 기본 1편 + (가로·3분 이하이고 원하면) 세로 크롭 쇼츠 1편
function outputsOf(clip) {
  const vertSrc = clip.h > clip.w;
  const long = clip.dur > RULE.shortsMaxSec;
  const outs = [];
  if (vertSrc && !long) outs.push({ kind: 'main', fmt: 'v', label: '세로 쇼츠 1080×1920' });
  else outs.push({ kind: 'main', fmt: 'h', label: '가로 1920×1080' + (vertSrc ? ' (3분 초과)' : '') });
  if (!vertSrc && !long && clip.cropShorts) outs.push({ kind: 'crop', fmt: 'v', label: '세로 크롭 쇼츠 1080×1920' });
  return outs;
}

// 본편 위 테두리: 보태니컬은 PNG, 가을은 낙엽 그림
async function frameOverlay(fmt, W, H) {
  if (!state.frame) return null;
  if (state.theme === 'botanical') return image(pickSrc(ASSET.corner, fmt));
  if (state.theme === 'autumn') return autumnFrame(W, H);
  return null;
}

// 한 편의 타임라인
function buildPlan(clip, out, opts = {}) {
  const fmt = out.fmt, [W, H] = SIZE[fmt];
  const botan = state.theme === 'botanical', autumn = state.theme === 'autumn';
  const cardOn = !!state.card && fmt === 'v';   // 카드에서는 제목이 카드 안에 있어요
  const segs = [];
  const vertSrc = clip.h > clip.w;

  if (state.opening === 'minimal') segs.push({ kind: 'still', style: 'minimal', role: 'opening', dur: MINIMAL_SEC });
  else if (state.opening !== 'none') segs.push({ kind: 'asset', role: 'opening', src: pickSrc(ASSET.opening[state.opening], fmt) });   // 가로·쇼츠 모두 오프닝부터
  const title = (clip.title || '').trim();
  if (title && !cardOn) {
    if (botan) segs.push({ kind: 'asset', role: 'title', src: pickSrc(ASSET.greenTitle, fmt), text: title });
    else if (autumn) segs.push({ kind: 'still', role: 'title', style: 'autumn', dur: AUTUMN.titleSec, text: title });
    else segs.push({ kind: 'still', role: 'title', dur: CLASSIC_TITLE_SEC, text: title });
  }
  const classic = !botan && !autumn;
  // 클래식: 오프닝 뒤 타이틀이 없으면 가운데 동그란 토순이 아이콘 카드로 한 번 쉬어 감
  if (classic && !title && segs.length && !cardOn && state.opening !== 'minimal') segs.push({ kind: 'still', style: 'icon', role: 'pause', dur: ICON_CARD_SEC });
  const main = {
    kind: 'clip', src: clip.url, clip, card: cardOn,
    mode: out.kind === 'crop' ? { cropX: clip.cropX } : (vertSrc && fmt === 'h') ? 'contain' : 'cover',
    caption: (clip.caption || '').trim(), capStart: clip.capStart || 0, capDur: clip.capDur || RULE.captionSec, role: 'main',
  };
  const intoMain = segs.length > 0;
  if (intoMain) { if (botan) segs[segs.length - 1].wipe = true; else if (autumn && !cardOn) main.leafIn = true; else main.fadeIn = RULE.fadeInFromIvory; }
  if (opts.noMain) return { fmt, W, H, segs, clip, out };   // 스타일 맛보기: 앞부분만
  segs.push(main);
  if (fmt === 'v' && state.ending !== 'none') {
    const end = { kind: 'asset', role: 'ending', src: ASSET.ending.v };
    if (botan) main.wipe = true; else end.xfade = RULE.shortsEndingXfade;
    segs.push(end);
  } else {
    main.fadeOut = RULE.fadeOutToIvory;
    if (classic && !cardOn) segs.push({ kind: 'still', style: 'icon', role: 'ending', dur: ICON_CARD_SEC });   // 끝도 아이콘 카드로 깔끔하게 닫음
  }
  return { fmt, W, H, segs, clip, out };
}

// ================================================================ 재생/녹화 엔진
// 타임라인은 '처음부터 몇 초'(T) 하나로 움직인다. 재생·녹화·편집 화면(멈춘 채 되감기)이 같은 그리기를 쓴다.
let stopFlag = false;

// 장면들의 영상을 불러오고 시작 시각을 계산 (cache를 주면 같은 영상을 다시 쓰고 소리는 끔)
async function loadSegs(plan, cache) {
  const get = async (src) => {
    if (!cache) return makeVideo(src);
    if (!cache.has(src)) cache.set(src, makeVideo(src, { muted: true }));
    return cache.get(src);
  };
  let T0 = 0;
  for (const s of plan.segs) {
    if (s.kind !== 'still') {
      s.el = await get(s.src);
      s.dur = s.el.duration;
      if (s.kind === 'clip') {
        const full = s.el.duration || s.clip.dur || 1;
        s.trimIn = clamp(s.clip.trimIn || 0, 0, Math.max(0, full - 0.5));
        const out = s.clip.trimOut > 0 ? Math.min(s.clip.trimOut, full) : full;
        s.dur = Math.max(0.5, out - s.trimIn);
      }
    }
    s.start = Math.max(0, T0 - (s.xfade || 0));
    T0 = s.start + s.dur;
    if (s.wipe) {
      s.wipeEl = await get(pickSrc(ASSET.wipe, plan.fmt));
      s.wipeAt = T0 - ASSET.wipe.cut;
    }
  }
  plan.total = T0;
  return plan;
}

// 장면의 '자기 시간' t
function segTime(s, T) {
  if (s.kind === 'still') return T - s.start;
  if (s.kind === 'clip') return s.el.currentTime - (s.trimIn || 0);
  return s.el.currentTime;
}

// 장면 하나 그리기
function paintSeg(ctx, plan, s, T, cornerImg) {
  const { W, H, fmt } = plan;
  const t = segTime(s, T);
  ctx.save();
  if (s.xfade) ctx.globalAlpha = clamp((T - s.start) / s.xfade);
  if (s.kind === 'still') ({ autumn: drawAutumnTitle, icon: drawIconCard, minimal: drawMinimalIntro }[s.style] || drawClassicTitle)(ctx, W, H, fmt, s.text, t);
  else if (s.kind === 'asset') {
    if (s.el.readyState >= 2) drawAsset(ctx, s.el, W, H);
    if (s.role === 'title') drawGreenTitleText(ctx, W, H, fmt, s.text, t);
  } else {
    if (s.card) {
      drawCard(ctx, W, H, s.clip, s.el, s.caption, s.mode && typeof s.mode === 'object' ? 'crop' : 'main');
    } else {
      if (state.grade && 'filter' in ctx) ctx.filter = 'sepia(0.07) saturate(1.04) brightness(1.01)';
      if (s.el.readyState >= 2) drawVideo(ctx, s.el, W, H, s.mode);
      ctx.filter = 'none';
      if (cornerImg) ctx.drawImage(cornerImg, 0, 0, W, H);
      const vis = 1 - (s.fadeIn ? 1 - clamp(t / s.fadeIn) : 0);
      if (state.watermark) drawWatermark(ctx, W, H, fmt, vis);
      drawCaption(ctx, W, H, fmt, s.caption, t, s.capStart, s.capDur);
    }
    // 아이보리에서 열리고 / 아이보리로 닫힘
    let iv = 0;
    if (s.fadeIn) iv = Math.max(iv, 1 - clamp(t / s.fadeIn));
    if (s.fadeOut) iv = Math.max(iv, clamp((t - (s.dur - s.fadeOut)) / s.fadeOut));
    if (iv > 0) { ctx.globalAlpha *= iv; ctx.fillStyle = RULE.ivory; ctx.fillRect(0, 0, W, H); }
  }
  ctx.restore();
}

// T 시점의 한 화면
function paintFrame(ctx, plan, T, cornerImg) {
  const { W, H, segs } = plan;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
  ctx.fillStyle = RULE.ivory; ctx.fillRect(0, 0, W, H);
  const live = segs.filter((s) => T >= s.start && (T < s.start + s.dur || s === segs[segs.length - 1]));
  for (const s of live) paintSeg(ctx, plan, s, T, cornerImg);
  if (!live.length) { const prev = [...segs].reverse().find((s) => T >= s.start); if (prev) paintSeg(ctx, plan, prev, T, cornerImg); }
  for (const s of segs) {
    if (s.wipeEl && T >= s.wipeAt && T < s.wipeAt + (s.wipeEl.duration || 2) && !s.wipeEl.ended && s.wipeEl.readyState >= 2) {
      keyer ||= new Keyer();
      ctx.drawImage(keyer.key(s.wipeEl), 0, 0, W, H);
    }
  }
  for (const s of segs) if (s.leafIn) drawAutumnTransition(ctx, W, H, T - s.start + AUTUMN.transCut);
}

// 재생(소리 포함) 또는 녹화. from 초부터, until 초까지(없으면 끝까지)
async function runPlan(plan, { record, onProgress, from = 0, until = Infinity }) {
  const { W, H, fmt, segs, clip } = plan;
  screen.width = W; screen.height = H;
  const ctx = sctx;
  keyer ||= new Keyer();
  const ac = getAudioCtx(); await ac.resume();
  const words = segs.map((s) => (s.text || '') + (s.caption || '') + (s.clip ? (s.clip.title || '') : '')).join('');
  await document.fonts.load('300 60px "Noto Sans KR"', 'TOSOONI 토순이 친구' + words);
  await document.fonts.load('400 40px "Noto Sans KR"', '토순이 친구' + words);
  await document.fonts.load('500 40px "Noto Sans KR"', words + '토순이 친구').catch(() => {});
  const cornerImg = state.card && fmt === 'v' ? null : await frameOverlay(fmt, W, H);
  await loadSegs(plan);

  // 오디오: 각 소스 → 음량 → 마스터 → 리미터 → 스피커(+녹음)
  const master = ac.createGain();
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.12;
  master.connect(limiter); limiter.connect(ac.destination);
  const dest = record ? ac.createMediaStreamDestination() : null;
  if (dest) limiter.connect(dest);
  const nodes = [];
  const route = (el, gain) => {
    const src = ac.createMediaElementSource(el), g = ac.createGain();
    g.gain.value = gain; src.connect(g).connect(master); nodes.push(src, g); return g;
  };
  for (const s of segs) {
    if (s.kind === 'still') continue;
    let g = 1;
    if (s.kind === 'clip') {
      const a = clip.audio;
      const useClean = (state.clean || clip.embeddedClean) && a && !a.none;
      if (useClean && a.hissOnly && state.muteHiss) g = 0;
      else if (state.normalize) g = gainFor(useClean ? a.cleanLufs : await lufsOfUrl(clip.url));
      // 다듬은 소리는 따로 재생하고 영상의 원래 소리는 끈다
      if (state.clean && clip.cleanAudio) {
        s.audioEl = await makeMedia('audio', clip.cleanAudio);
        s.gain = route(s.audioEl, g); route(s.el, 0);
      }
    } else if (state.normalize) g = gainFor(await lufsOfUrl(s.src));
    if (!s.gain) s.gain = route(s.el, g);
    if (s.wipeEl) route(s.wipeEl, 1);
  }
  const total = plan.total;
  from = clamp(from, 0, Math.max(0, total - 0.05));
  const end = Math.min(total, until);

  let rec = null, chunks = [], mime = '';
  if (record) {
    if (!window.MediaRecorder) throw new Error('이 브라우저는 영상 저장을 지원하지 않아요. 컴퓨터의 크롬으로 열어 주세요.');
    const stream = screen.captureStream(30);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    mime = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4d0028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((m) => MediaRecorder.isTypeSupported(m)) || '';
    rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 192_000 });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  }
  const play = async (el) => { try { await el.play(); } catch (e) { el.muted = true; await el.play().catch(() => {}); } };

  // 시작 위치의 첫 장면을 맞춰 두고 시작
  for (const s of segs) {
    if (!s.el) continue;
    const off = clamp(from - s.start, 0, s.dur);
    s.el.currentTime = (s.trimIn || 0) + off;
    if (s.audioEl) s.audioEl.currentTime = s.el.currentTime;
    if (from >= s.start + s.dur) { s.started = s.stopped = true; }
  }
  for (const s of segs) if (s.wipeEl && from > s.wipeAt) { s.wipeStarted = true; if (from < s.wipeAt + (s.wipeEl.duration || 2)) { s.wipeEl.currentTime = from - s.wipeAt; play(s.wipeEl); } }
  ctx.fillStyle = RULE.ivory; ctx.fillRect(0, 0, W, H);
  if (rec) rec.start(1000);
  const t0 = performance.now() / 1000 + 0.05 - from;
  let lastT = from;
  await new Promise((resolve) => {
    let fin = false;
    const tick = () => {
      if (fin) return;
      const T = performance.now() / 1000 - t0;
      if (stopFlag || T >= end + 0.05) { fin = true; resolve(); return; }
      lastT = Math.min(T, total);
      for (const s of segs) {
        if (s.audioEl && s.started && !s.stopped && Math.abs(s.audioEl.currentTime - s.el.currentTime) > 0.12) s.audioEl.currentTime = s.el.currentTime;
        if (s.el && !s.started && T >= s.start) {
          s.started = true; play(s.el); if (s.audioEl) play(s.audioEl);
          if (s.fadeOut) s.gain.gain.setTargetAtTime(0, ac.currentTime + Math.max(0, s.start + s.dur - s.fadeOut - T), s.fadeOut / 3);
        }
        if (s.el && s.started && !s.stopped && T >= s.start + s.dur + 0.1) { s.stopped = true; s.el.pause(); if (s.audioEl) s.audioEl.pause(); }
        if (s.wipeEl && !s.wipeStarted && T >= s.wipeAt) { s.wipeStarted = true; play(s.wipeEl); }
      }
      paintFrame(ctx, plan, T, cornerImg);
      onProgress && onProgress(lastT, total);
      if (document.hidden) setTimeout(tick, 1000 / 30); else requestAnimationFrame(tick);
    };
    tick();
  });

  let blob = null;
  if (rec) {
    await sleep(120);
    const stopped = new Promise((r) => (rec.onstop = r)); rec.stop(); await stopped;
    blob = new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] });
  }
  try { limiter.disconnect(); master.disconnect(); nodes.forEach((n) => n.disconnect()); } catch (e) {}
  for (const s of segs) { dropVideo(s.el); dropVideo(s.wipeEl); dropVideo(s.audioEl); }
  return { blob, mime, total, lastT };
}

// ================================================================ UI
function setStatus(t) { $('status').textContent = t; }
function setBar(p) { $('barFill').style.width = (clamp(p) * 100).toFixed(1) + '%'; }

// 미리보기 재생 중이면 멈추고 끝날 때까지 기다림 (만들기 중에는 그대로)
async function stopPreview() {
  if (!(state.running && ed.playing)) return;
  stopFlag = true;
  while (state.running) await sleep(30);
}
function setupSeg(id, key) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || (state.running && !ed.playing)) return;
    (async () => {
      await stopPreview();
      state[key] = b.dataset.v; refresh();
      tasteStyle(key, b);
    })();
  });
}
setupSeg('themeSeg', 'theme'); setupSeg('openingSeg', 'opening'); setupSeg('endingSeg', 'ending');
for (const k of ['watermark', 'grade', 'frame', 'clean', 'muteHiss', 'normalize']) $(k).addEventListener('change', async (e) => { await stopPreview(); state[k] = e.target.checked; refresh(); });

const paint = (id, v) => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));

function refresh() {
  paint('themeSeg', state.theme); paint('openingSeg', state.opening); paint('endingSeg', state.ending);
  $('themeNote').textContent = {
    classic: '본편은 깨끗하게 두고, 아이보리 타이틀과 부드러운 페이드로만 이어요.',
    autumn: '크림 종이 위에 단풍잎·은행잎이 내려앉는 타이틀, 낙엽이 쏟아지며 넘어가는 전환이에요.',
    botanical: '초록 타이틀 카드와 잎 전환을 써요. 본편에 초록이 많아지면 무거워 보일 수 있어요.',
  }[state.theme];
  $('frameCheck').hidden = state.theme === 'classic';
  $('frameLabel').textContent = state.theme === 'autumn' ? '아래 구석에 낙엽 몇 장' : '보태니컬 모서리 테두리';
  if (state.theme === 'classic') state.frame = false;
  $('frame').checked = state.frame;
  const ready = state.clips.filter((c) => c.status === 'ready');
  const busy = state.clips.some((c) => c.status === 'preparing');
  $('exportBtn').disabled = state.running || !ready.length || busy;
  fillPicker();
  $('stopBtn').hidden = !state.running;
  $('stageEmpty').hidden = state.clips.length > 0;
  const lock = state.running && !ed.playing;   // 만드는 중에만 잠금 (미리보기 재생 중에는 바로 바꿀 수 있게)
  document.querySelectorAll('.seg button, .check input, .clip-card input, .clip-card button, #editor input, #editor .link, .r-fix').forEach((b) => { b.disabled = lock; });
  $('edMake').disabled = state.running;
  $('edPlay').classList.toggle('on', state.running && ed.playing);
  if (!state.running) {
    if (!state.clips.length) setStatus('영상을 올려 주세요');
    else if (busy) setStatus('읽을 수 없는 형식이라 변환하는 중이에요. 끝나면 미리보기와 만들기를 누를 수 있어요.');
    else {
      const n = ready.reduce((a, c) => a + outputsOf(c).length, 0);
      setStatus(`영상 ${n}편을 만들 준비가 됐어요`);
    }
    drawStill();
  }
}

// 멈춰 있을 때: 고른 결과물의 한 장면(본편 + 로고 + 자막)
let stillTok = 0;
async function drawStill() {
  const tok = ++stillTok;
  const sel = currentSelection();
  // 고를 수 있는 영상이 있으면 편집 화면(타임라인)으로 보여 줌
  if (sel && sel.clip.status === 'ready' && sel.clip.thumb && sel.clip.thumb.videoWidth) {
    ed.ready = edBuild().then((p) => { if (p && !state.running) edSeek(ed.T); return p; }).catch((e) => { console.error(e); return null; });
    return ed.ready;
  }
  $('editor').hidden = true;
  const fmt = sel ? sel.out.fmt : 'h';
  const [W, H] = SIZE[fmt];
  $('stage').classList.toggle('vert', fmt === 'v');
  screen.width = W; screen.height = H;
  sctx.fillStyle = RULE.ivory; sctx.fillRect(0, 0, W, H);
  if (!sel || !sel.clip.thumb || !sel.clip.thumb.videoWidth) return;
  const cardOn = !!state.card && fmt === 'v';
  await document.fonts.load('300 30px "Noto Sans KR"', 'TOSOONI').catch(() => {});
  if (cardOn) {
    await document.fonts.load('500 40px "Noto Sans KR"', (sel.clip.title || '') + '토순이 친구').catch(() => {});
    await document.fonts.load('400 40px "Noto Sans KR"', (sel.clip.caption || '') + '토순이 친구').catch(() => {});
  }
  const corner = cardOn ? null : await frameOverlay(fmt, W, H).catch(() => null);
  if (tok !== stillTok || state.running) return;
  if (cardOn) { drawCard(sctx, W, H, sel.clip, sel.clip.thumb, sel.clip.caption, sel.out.kind); return; }
  const c = sel.clip, vertSrc = c.h > c.w;
  const mode = sel.out.kind === 'crop' ? { cropX: c.cropX } : (vertSrc && fmt === 'h') ? 'contain' : 'cover';
  if (state.grade && 'filter' in sctx) sctx.filter = 'sepia(0.07) saturate(1.04) brightness(1.01)';
  drawVideo(sctx, c.thumb, W, H, mode);
  sctx.filter = 'none';
  if (corner) sctx.drawImage(corner, 0, 0, W, H);
  if (state.watermark) drawWatermark(sctx, W, H, fmt, 1);
  if (c.caption) drawCaption(sctx, W, H, fmt, c.caption.trim(), (c.capStart || 0) + 1.5, c.capStart, c.capDur);
}
function currentSelection() {
  const pick = state.selected && state.clips.find((c) => c.id === state.selected.clipId);
  const clip = pick || state.clips.find((c) => c.thumb && c.thumb.videoWidth);
  if (!clip) return null;
  const outs = outputsOf(clip);
  const out = (pick && outs.find((o) => o.kind === state.selected.kind)) || outs[0];
  return { clip, out };
}

function renderClipList() {
  const ul = $('clipList');
  ul.innerHTML = '';
  state.clips.forEach((c, idx) => {
    const li = document.createElement('li');
    li.className = 'clip-card';
    const vertSrc = c.h > c.w, long = c.dur > RULE.shortsMaxSec;
    const outs = c.w ? outputsOf(c) : [];
    li.innerHTML = `
      <div class="clip-top">
        <div class="thumb"></div>
        <div class="meta">
          <div class="name"></div>
          <div class="sub">${fmtTime(c.dur)}${c.w ? ` · 원본 ${vertSrc ? '세로' : '가로'} ${c.w}×${c.h}` : ''}</div>
          <div class="sub outs">${outs.map((o) => '→ ' + o.label).join('<br>')}</div>
          <div class="sub warn" hidden></div>
        </div>
        <button class="icon-btn rm" title="빼기" aria-label="이 영상 빼기">✕</button>
      </div>
      <div class="clip-fields">
        <label class="mini">타이틀 카드 <small>자유롭게 한 줄. 비우면 바로 본편</small>
          <input type="text" class="f-title plain" maxlength="30" placeholder="예) 오늘은 산책하러 가는 날" aria-label="${idx + 1}번 영상 제목 (자유롭게 한 줄, 비우면 제목 장면 없음)"></label>
        <label class="mini">도입부 자막 <small>반전이 있는 영상만. 위쪽에 작게 ${RULE.captionSec}초</small>
          <input type="text" class="f-cap plain" maxlength="40" placeholder="예) 그런데 갑자기…" aria-label="${idx + 1}번 영상 도입부 자막 (반전 있는 영상만)"></label>
        ${!vertSrc && !long && c.w ? `
        <label class="check"><input type="checkbox" class="f-crop" aria-label="${idx + 1}번 영상 세로 크롭 쇼츠도 만들기"> 세로 크롭 쇼츠도 만들기 <small>토끼가 잘리지 않을 때만</small></label>
        <div class="crop-row" ${c.cropShorts ? '' : 'hidden'}><span>왼쪽</span><input type="range" class="f-cropx" min="0" max="1" step="0.01" aria-label="${idx + 1}번 크롭 위치 슬라이더"><span>오른쪽</span>
          <input type="number" class="plain f-cropn" min="0" max="100" step="1" aria-label="${idx + 1}번 크롭 위치 퍼센트 (0 왼쪽 끝, 50 가운데, 100 오른쪽 끝)"><span>%</span></div>` : ''}
        <div class="prev-row">${outs.map((o) => { const nm = o.kind === 'crop' ? '크롭 쇼츠' : o.fmt === 'v' ? '쇼츠' : '가로'; return `<button class="btn ghost small f-prev" data-kind="${o.kind}" aria-label="${idx + 1}번 ${nm} 미리보기">▶ 미리보기 · ${nm}</button><button class="btn ghost small f-sheet" data-kind="${o.kind}" aria-label="${idx + 1}번 ${nm} 장면 모음 보기">▦ 장면 모음 · ${nm}</button>`; }).join('')}</div>
        <img class="sheet" hidden alt="${idx + 1}번 영상 장면 모음">
      </div>`;
    li.querySelector('.name').textContent = `${idx + 1}. ${c.name}`;
    if (c.thumb && c.thumb.videoWidth) {
      const tv = document.createElement('canvas');
      tv.width = 128; tv.height = 80;
      drawVideo(tv.getContext('2d'), c.thumb, 128, 80, 'cover');
      li.querySelector('.thumb').append(tv);
    }
    c.noteEl = li.querySelector('.warn');
    setClipNote(c, c.note || '');
    const fT = li.querySelector('.f-title'); fT.value = c.title || '';
    fT.addEventListener('input', () => { c.title = fT.value; select(c, state.selected && state.selected.clipId === c.id ? state.selected.kind : 'main'); });
    const fC = li.querySelector('.f-cap'); fC.value = c.caption || '';
    fC.addEventListener('input', () => { c.caption = fC.value; select(c, state.selected && state.selected.clipId === c.id ? state.selected.kind : 'main'); });
    const fCrop = li.querySelector('.f-crop');
    if (fCrop) {
      fCrop.checked = !!c.cropShorts;
      fCrop.addEventListener('change', () => { c.cropShorts = fCrop.checked; if (c.cropShorts) state.selected = { clipId: c.id, kind: 'crop' }; renderClipList(); refresh(); });
      const fx = li.querySelector('.f-cropx'), fn = li.querySelector('.f-cropn');
      fx.value = c.cropX; fn.value = Math.round(c.cropX * 100);
      fx.addEventListener('input', () => { c.cropX = +fx.value; fn.value = Math.round(c.cropX * 100); select(c, 'crop'); });
      fn.addEventListener('change', () => { c.cropX = clamp((+fn.value || 0) / 100); fx.value = c.cropX; fn.value = Math.round(c.cropX * 100); select(c, 'crop'); });
    }
    li.querySelector('.rm').addEventListener('click', () => {
      state.clips.splice(state.clips.indexOf(c), 1);
      URL.revokeObjectURL(c.url); if (c.prep) URL.revokeObjectURL(c.prep.url); dropVideo(c.thumb);
      renderClipList(); refresh();
    });
    li.querySelectorAll('.f-prev').forEach((b) => b.addEventListener('click', () => preview(c, b.dataset.kind)));
    if (c.sheetUrl) { const im = li.querySelector('.sheet'); im.src = c.sheetUrl; im.hidden = false; }
    li.querySelectorAll('.f-sheet').forEach((b) => b.addEventListener('click', () => contactSheet(c, b.dataset.kind)));
    const busy = c.status !== 'ready';
    li.querySelectorAll('.f-prev').forEach((b) => { b.disabled = busy || state.running; });
    ul.append(li);
  });
}
// 장면 모음: 결과물과 같은 화면 배치로 6장면을 한 장에 (토끼 잘림·로고·자막 위치를 한눈에)
async function contactSheet(c, kind) {
  const out = outputsOf(c).find((o) => o.kind === kind);
  if (!out) return;
  const [W, H] = SIZE[out.fmt], vertSrc = c.h > c.w;
  const mode = kind === 'crop' ? { cropX: c.cropX } : (vertSrc && out.fmt === 'h') ? 'contain' : 'cover';
  const cols = 3, rows = 2, tw = out.fmt === 'v' ? 270 : 480, th = Math.round(tw * H / W), pad = 8;
  const sheet = document.createElement('canvas');
  sheet.width = cols * tw + (cols + 1) * pad; sheet.height = rows * th + (rows + 1) * pad;
  const g = sheet.getContext('2d'); g.fillStyle = RULE.ivory; g.fillRect(0, 0, sheet.width, sheet.height);
  const big = document.createElement('canvas'); big.width = W; big.height = H; const bg = big.getContext('2d');
  const v = await makeVideo(c.url, { muted: true });
  for (let i = 0; i < cols * rows; i++) {
    const t = (c.dur || v.duration) * (i + 0.5) / (cols * rows);
    v.currentTime = t;
    await new Promise((r) => { v.onseeked = r; setTimeout(r, 2000); });
    bg.fillStyle = '#000'; bg.fillRect(0, 0, W, H);
    drawVideo(bg, v, W, H, mode);
    if (state.watermark) drawWatermark(bg, W, H, out.fmt, 1);
    const u = t - (c.trimIn || 0), cs = c.capStart || 0;
    if (c.caption && u >= cs && u < cs + (c.capDur || RULE.captionSec)) drawCaption(bg, W, H, out.fmt, c.caption.trim(), cs + 1.5, cs, c.capDur);
    const x = pad + (i % cols) * (tw + pad), y = pad + Math.floor(i / cols) * (th + pad);
    g.drawImage(big, x, y, tw, th);
    g.fillStyle = 'rgba(47,46,43,.75)'; g.fillRect(x, y + th - 22, 56, 22);
    g.fillStyle = '#fff'; g.font = '400 13px "Noto Sans KR"'; g.fillText(fmtTime(t), x + 8, y + th - 7);
  }
  dropVideo(v);
  c.sheetUrl = sheet.toDataURL('image/jpeg', 0.85);
  renderClipList();
}
function select(c, kind) { state.selected = { clipId: c.id, kind }; drawStill(); }

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
  for (const file of list) {
    const url = URL.createObjectURL(file);
    let v;
    try { v = await makeVideo(url, { muted: true }); }
    catch (e) { URL.revokeObjectURL(url); setStatus(`"${file.name}"을(를) 열지 못했어요.`); continue; }
    v.currentTime = Math.min(1, (v.duration || 2) / 3);
    await new Promise((r) => { v.onseeked = r; setTimeout(r, 1500); });
    const clip = { id: ++clipSeq, origFile: file, url, name: file.name, w: v.videoWidth, h: v.videoHeight, dur: v.duration, thumb: v,
      title: '', caption: '', cropShorts: false, cropX: 0.5, capStart: 0, capDur: RULE.captionSec, trimIn: 0, trimOut: 0,
      // 원본이 재생되면 바로 쓸 수 있음. 소리 다듬기는 뒤에서.
      status: v.videoWidth ? 'ready' : 'preparing', note: '소리 다듬기 순서를 기다리는 중…' };
    state.clips.push(clip);
    clip.prepDone = prepQueue = prepQueue.then(() => prepareClip(clip)).catch((e) => console.error(e));
  }
  renderClipList(); refresh();
}
$('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

async function withRun(fn) {
  if (state.running) return;
  state.running = true; stopFlag = false; refresh(); renderClipList();
  try { await fn(); }
  catch (e) { console.error(e); setStatus('문제가 생겼어요: ' + (e.message || e)); }
  finally { state.running = false; renderClipList(); refresh(); }
}

function preview(clip, kind) {
  state.selected = { clipId: clip.id, kind };
  $('studio').scrollIntoView({ behavior: 'smooth', block: 'start' });
  playRange(0, Infinity);
}

const results = [];
// 한 편 만들기 (녹화). 같은 결과가 이미 있으면 새것으로 바꿔 끼움
async function makeOne(c, o, label) {
  if (state.clean && !c.prepFinished) {
    setStatus(`${c.name} 소리 다듬기가 끝나길 기다리는 중…`);
    await Promise.race([c.prepDone, sleep(5 * 60 * 1000)]);
    if (stopFlag) return false;
  }
  state.selected = { clipId: c.id, kind: o.kind };
  $('stage').classList.toggle('vert', o.fmt === 'v');
  const r = await runPlan(buildPlan(c, o), { record: true, onProgress: (t, T) => { edHead(t, T); setBar(t / T); setStatus(`${label} · ${c.name} · ${o.label} · ${fmtTime(t)} / ${fmtTime(T)}`); } });
  if (stopFlag || !r.blob) return false;
  addResult(c, o, r);
  return true;
}
$('exportBtn').addEventListener('click', () => withRun(async () => {
  const jobs = [];
  for (const c of state.clips.filter((x) => x.status === 'ready')) for (const o of outputsOf(c)) jobs.push({ c, o });
  $('studio').scrollIntoView({ behavior: 'smooth', block: 'start' });
  let done = 0;
  for (let j = 0; j < jobs.length && !stopFlag; j++) if (await makeOne(jobs[j].c, jobs[j].o, `${j + 1}/${jobs.length}편 만드는 중`)) done++;
  setBar(stopFlag ? 0 : 1);
  if (!stopFlag && jobs.length) {
    state.selected = { clipId: jobs[0].c.id, kind: jobs[0].o.kind }; ed.key = '';
    setTimeout(() => setStatus(`완성! ${done}편이 아래에 있어요. 고칠 곳이 있으면 위에서 바로 고치고 '이 편 다시 만들기'를 눌러 주세요.`), 0);
  }
}));
$('stopBtn').addEventListener('click', () => { stopFlag = true; });

// 3번 칸의 '어떤 영상을 볼지' 고르기 + 미리보기
function fillPicker() {
  const sel = $('pickSel'), cur = currentSelection();
  const opts = [];
  state.clips.forEach((c, i) => { if (c.w) for (const o of outputsOf(c)) opts.push({ v: c.id + ':' + o.kind, t: `${i + 1}. ${c.name} → ${o.label}`, ready: c.status === 'ready' }); });
  sel.innerHTML = opts.map((o) => `<option value="${o.v}">${esc(o.t)}</option>`).join('');
  if (cur) sel.value = cur.clip.id + ':' + cur.out.kind;
  $('pickRow').hidden = opts.length === 0;
  sel.disabled = state.running;
  const pick = opts.find((o) => o.v === sel.value);
  $('previewBtn').disabled = state.running || !pick || !pick.ready;
}
$('pickSel').addEventListener('change', () => {
  const [id, kind] = $('pickSel').value.split(':');
  state.selected = { clipId: +id, kind }; refresh();
});
$('previewBtn').addEventListener('click', () => {
  const cur = currentSelection();
  if (cur) preview(cur.clip, cur.out.kind);
});

function addResult(c, o, { blob, mime }) {
  const isMp4 = (mime || '').startsWith('video/mp4');
  const base = c.name.replace(/\.\w+$/, '');
  const name = `tosooni-${base}-${o.kind === 'crop' ? 'crop-shorts' : o.fmt === 'v' ? 'shorts' : 'video'}.${isMp4 ? 'mp4' : 'webm'}`;
  const url = URL.createObjectURL(blob);
  results.push({ name, url });
  const ul = $('results'); ul.hidden = false;
  const li = document.createElement('li');
  const shorts = o.fmt === 'v';
  const title = (c.title || '').trim() || '토순이 친구';
  const key = c.id + ':' + o.kind;
  li.innerHTML = `<video controls playsinline preload="metadata"></video>
    <div class="r-meta">
      <div class="name"></div><div class="sub"></div>
      <div class="r-actions"><a class="btn small" download>내려받기</a><button class="btn ghost small r-fix" type="button">고치기</button><button class="btn ghost small yt-open">유튜브에 올리기</button></div>
      <div class="yt-form" hidden>
        <label class="mini">제목<input type="text" class="plain yt-title" maxlength="100"></label>
        <label class="mini">설명<textarea class="plain yt-desc" rows="3"></textarea></label>
        <label class="mini">공개 범위
          <select class="plain yt-privacy"><option value="private">비공개</option><option value="unlisted">일부 공개 (링크 있는 사람만)</option><option value="public">공개</option></select></label>
        <label class="check"><input type="checkbox" class="yt-kids"> 아동용 영상이에요</label>
        <div class="r-actions"><button class="btn small yt-go">올리기</button></div>
        <div class="bar"><div class="bar-fill yt-bar"></div></div>
        <div class="sub yt-msg"></div>
      </div>
    </div>`;
  li.querySelector('video').src = url;
  li.querySelector('.name').textContent = name;
  li.querySelector('.sub').textContent = `${o.label} · ${(blob.size / 1048576).toFixed(1)}MB`;
  const a = li.querySelector('a'); a.href = url; a.download = name;
  li.querySelector('.yt-title').value = title + (shorts ? ' #Shorts' : '');
  li.querySelector('.yt-desc').value = '토순이 친구 🐰\n\n#토순이친구 #반려토끼 #토끼' + (shorts ? ' #Shorts' : '');
  li.querySelector('.yt-open').addEventListener('click', () => { const f = li.querySelector('.yt-form'); f.hidden = !f.hidden; });
  li.querySelector('.yt-go').addEventListener('click', () => uploadToYouTube(li, blob, mime, shorts));
  li.querySelector('.r-fix').addEventListener('click', () => {
    state.selected = { clipId: c.id, kind: o.kind }; ed.key = '';
    refresh(); $('studio').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  if (shorts) li.classList.add('vert');
  li.dataset.key = key;
  const old = ul.querySelector(`li[data-key="${key}"]`);
  if (old) { const ov = old.querySelector('video'); if (ov && ov.src) URL.revokeObjectURL(ov.src); old.replaceWith(li); li.classList.add('fresh'); }
  else ul.prepend(li);
  edMakeLabel();
}

// ================================================================ 편집 화면: 타임라인(초) · 바로 고치기 · 이 편만 다시 만들기
// 멈춘 채로 원하는 초를 끌어 보며 제목·자막·자막 시점·본편 앞뒤를 고친다. 그리는 방법은 만들기와 똑같아서 보이는 그대로 나온다.
const ed = { plan: null, key: '', T: 0, cache: new Map(), busy: false, pending: null, corner: null, playing: false, buildTok: 0, ready: Promise.resolve(null) };
const fmt1 = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), r = s - m * 60; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1); };
const ROLE_LABEL = { opening: '오프닝', title: '제목', pause: '쉼표', main: '본편', ending: '마무리' };
const mainOf = (plan) => plan && plan.segs.find((x) => x.kind === 'clip');

function seekTo(v, t) {
  return new Promise((r) => {
    t = Math.max(0, Math.min(t, (v.duration || t + 1) - 0.02));
    if (Math.abs(v.currentTime - t) < 0.012 && v.readyState >= 2) return r();
    let done = false;
    const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); r(); };
    v.addEventListener('seeked', fin); v.currentTime = t; setTimeout(fin, 1500);
  });
}

async function edBuild() {
  const sel = currentSelection();
  const ok = sel && sel.clip.status === 'ready';
  $('editor').hidden = !ok;
  if (!ok) { ed.plan = null; return null; }
  const tok = ++ed.buildTok;
  const plan = buildPlan(sel.clip, sel.out);
  const words = plan.segs.map((x) => (x.text || '') + (x.caption || '')).join('') + (sel.clip.title || '') + (sel.clip.caption || '');
  await Promise.all([
    document.fonts.load('300 60px "Noto Sans KR"', 'TOSOONI 토순이 친구' + words),
    document.fonts.load('400 40px "Noto Sans KR"', '토순이 친구' + words),
    document.fonts.load('500 40px "Noto Sans KR"', words + '토순이'),
  ]).catch(() => {});
  await loadSegs(plan, ed.cache);
  const corner = state.card && plan.fmt === 'v' ? null : await frameOverlay(plan.fmt, plan.W, plan.H).catch(() => null);
  if (tok !== ed.buildTok) return null;
  const key = sel.clip.id + ':' + sel.out.kind;
  if (ed.key !== key) { ed.key = key; const m = mainOf(plan); ed.T = m ? m.start + Math.min(0.8, m.dur / 2) : 0; }
  ed.plan = plan; ed.corner = corner;
  ed.T = clamp(ed.T, 0, Math.max(0, plan.total - 0.04));
  edTimeline(); edInspector(sel);
  return plan;
}

// 타임라인 그리기: 장면 띠 + 자막 표시 + 눈금
function edTimeline() {
  const p = ed.plan; if (!p) return;
  const tot = p.total || 1, pct = (x) => (x / tot * 100).toFixed(3) + '%';
  $('tlBands').innerHTML = p.segs.map((x) => {
    const role = x.role || (x.kind === 'clip' ? 'main' : 'title');
    return `<div class="band b-${role}" style="left:${pct(x.start)};width:${pct(x.dur)}"><span>${ROLE_LABEL[role] || ''}</span></div>`;
  }).join('');
  const m = mainOf(p), cap = $('tlCap');
  if (m && m.caption && !m.card) {
    const a = m.start + (m.capStart || 0), d = Math.min(m.capDur || RULE.captionSec, m.start + m.dur - a);
    cap.hidden = d <= 0; cap.style.left = pct(a); cap.style.width = pct(Math.max(0, d));
  } else cap.hidden = true;
  const step = tot > 120 ? 30 : tot > 60 ? 10 : tot > 20 ? 5 : 2;
  let h = '';
  for (let x = 0; x <= tot + 0.001; x += step) h += `<span style="left:${pct(x)}">${fmtTime(x)}</span>`;
  $('tlTicks').innerHTML = h;
  const r = $('tlRange'); r.max = String(Math.max(0.05, tot - 0.04));
  $('edTotal').textContent = fmt1(tot);
  edHead();
  edMakeLabel();
}
function edHead(t, total) {
  const tot = total || (ed.plan ? ed.plan.total : 1) || 1;
  const T = t == null ? ed.T : t;
  $('tlHead').style.left = (clamp(T / tot) * 100).toFixed(3) + '%';
  $('edNow').textContent = fmt1(T);
  if (document.activeElement !== $('tlRange')) $('tlRange').value = String(T);
}
function edMakeLabel() {
  const has = !!document.querySelector(`#results li[data-key="${ed.key}"]`);
  $('edMake').textContent = has ? '이 편 다시 만들기' : '이 편 만들기';
}

// 원하는 초로 (빨리 끌어도 마지막 위치만 그림)
function edSeek(T) {
  if (!ed.plan) return;
  ed.T = clamp(T, 0, Math.max(0, ed.plan.total - 0.04));
  edHead();
  ed.pending = ed.T;
  if (!ed.busy) edPump();
}
async function edPump() {
  ed.busy = true;
  try { while (ed.pending != null) { const T = ed.pending; ed.pending = null; await edPaint(T); } }
  finally { ed.busy = false; }
}
async function edPaint(T) {
  const p = ed.plan; if (!p || state.running) return;
  const last = p.segs[p.segs.length - 1], waits = [];
  for (const x of p.segs) {
    if (x.el && T >= x.start - 0.01 && (T < x.start + x.dur || x === last)) waits.push(seekTo(x.el, (x.trimIn || 0) + clamp(T - x.start, 0, x.dur - 0.04)));
    if (x.wipeEl && T >= x.wipeAt && T < x.wipeAt + (x.wipeEl.duration || 2)) waits.push(seekTo(x.wipeEl, T - x.wipeAt));
  }
  await Promise.all(waits);
  if (state.running || p !== ed.plan) return;
  if (screen.width !== p.W || screen.height !== p.H) { screen.width = p.W; screen.height = p.H; }
  $('stage').classList.toggle('vert', p.fmt === 'v');
  paintFrame(sctx, p, T, ed.corner);
}

// 재생: from~until 초 (소리 포함). 재생 중 누르면 멈춤
function playRange(from, until, plan, onFrame) {
  if (state.running) { stopFlag = true; return; }
  const sel = currentSelection(); if (!sel && !plan) return;
  ed.playing = true;
  return withRun(async () => {
    const p = plan || buildPlan(sel.clip, sel.out);
    $('stage').classList.toggle('vert', p.fmt === 'v');
    const r = await runPlan(p, { record: false, from, until, onProgress: (t, T) => { if (!plan) { ed.T = t; edHead(t, T); } setBar(t / T); setStatus(`재생 ${fmt1(t)} / ${fmt1(T)}`); if (onFrame) onFrame(); } });
    if (!plan) ed.T = r.lastT;
  }).finally(() => { ed.playing = false; setBar(0); $('edPlay').classList.remove('on'); });
}
$('edPlay').addEventListener('click', () => {
  if (state.running) { stopFlag = true; return; }
  if (!ed.plan) return;
  playRange(ed.T >= ed.plan.total - 0.15 ? 0 : ed.T, Infinity);
});
$('edBack').addEventListener('click', () => edSeek(ed.T - 1));
$('edFwd').addEventListener('click', () => edSeek(ed.T + 1));
$('tlRange').addEventListener('input', (e) => { if (!state.running) edSeek(+e.target.value); });
document.addEventListener('keydown', (e) => {
  if ($('editor').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || '';
  if (/INPUT|TEXTAREA|SELECT/.test(tag) && e.target.id !== 'tlRange') return;
  if (e.code === 'Space' && !/BUTTON/.test(tag)) { e.preventDefault(); $('edPlay').click(); }
  else if (e.key === 'ArrowLeft' && !state.running) { e.preventDefault(); edSeek(ed.T - (e.shiftKey ? 1 / 30 : 1)); }
  else if (e.key === 'ArrowRight' && !state.running) { e.preventDefault(); edSeek(ed.T + (e.shiftKey ? 1 / 30 : 1)); }
});

// 고친 뒤 다시 짜서 보여 주기. focus: 보여 줄 곳('title' | 'caption' | 'trimIn' | 'trimOut' | 'keep')
let edTimer = 0;
function edChanged(focus, delay = 220) {
  clearTimeout(edTimer);
  edTimer = setTimeout(async () => {
    syncClipCards();
    const p = await (ed.ready = edBuild());
    if (!p) return;
    const m = mainOf(p), ti = p.segs.find((x) => x.role === 'title');
    let T = ed.T;
    if (focus === 'title') T = ti ? ti.start + Math.min(2.0, ti.dur * 0.6) : (m ? m.start + 0.5 : 0);
    else if (focus === 'caption' && m) T = m.start + (m.capStart || 0) + 1.2;
    else if (focus === 'trimIn' && m) T = m.start + 0.4;
    else if (focus === 'trimOut' && m) T = m.start + m.dur - 0.3;
    edSeek(T);
  }, delay);
}
// 01번 영상 카드의 입력칸도 같은 값으로
function syncClipCards() {
  const i = state.clips.findIndex((c) => ed.key.startsWith(c.id + ':'));
  const li = $('clipList').children[i]; if (i < 0 || !li) return;
  const c = state.clips[i];
  const set = (q, v) => { const el = li.querySelector(q); if (el && document.activeElement !== el) el.value = v; };
  set('.f-title', c.title || ''); set('.f-cap', c.caption || '');
  set('.f-cropx', c.cropX); set('.f-cropn', Math.round(c.cropX * 100));
}
const selClip = () => { const s = currentSelection(); return s && s.clip; };

function edInspector(sel) {
  const c = sel.clip, m = mainOf(ed.plan);
  const put = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
  put('edTitle', c.title || ''); put('edCap', c.caption || '');
  put('edCapDur', c.capDur || RULE.captionSec);
  $('edCapAt').textContent = (c.capStart || 0).toFixed(1);
  $('edTitle').placeholder = state.card && sel.out.fmt === 'v' ? '카드 맨 위 제목 · 예) 강아지를 만난 토끼' : '예) 오늘은 산책하러 가는 날';
  // 본편 다듬기
  const dur = c.dur || (m && m.el.duration) || 1;
  const a = c.trimIn || 0, b = c.trimOut > 0 ? c.trimOut : dur;
  for (const [id, v] of [['trimA', a], ['trimB', b]]) { const r = $(id); r.max = String(dur); if (document.activeElement !== r) r.value = String(v); }
  $('shadeL').style.width = (a / dur * 100) + '%';
  $('shadeR').style.width = ((dur - b) / dur * 100) + '%';
  $('trimInfo').textContent = `${fmt1(a)} – ${fmt1(b)} · ${(b - a).toFixed(1)}초`;
  $('trimReset').hidden = !(a > 0 || c.trimOut > 0);
  drawStrip(c);
  // 크롭
  const crop = sel.out.kind === 'crop';
  $('edCropRow').hidden = !crop;
  if (crop) { put('edCrop', c.cropX); $('edCropVal').textContent = Math.round(c.cropX * 100) + '%'; }
}

// 본편 필름 띠: 원본 비율 그대로 칸칸이 (늘리지 않음). 한 장씩 뽑히는 대로 채워 감
const STRIP_N = 10;
async function drawStrip(c) {
  if (!c.frames) {
    c.frames = new Array(STRIP_N).fill(null);
    (async () => {
      try {
        const v = await makeVideo(c.url, { muted: true }), fh = 112, fw = Math.max(1, Math.round(fh * c.w / c.h));
        for (let i = 0; i < STRIP_N; i++) {
          await seekTo(v, (c.dur || v.duration) * (i + 0.5) / STRIP_N);
          await Promise.race([frameReady(v), sleep(220)]);
          const f = document.createElement('canvas'); f.width = fw; f.height = fh;
          f.getContext('2d').drawImage(v, 0, 0, fw, fh);
          c.frames[i] = f;
          const s = currentSelection(); if (s && s.clip === c) paintStrip(c);
        }
        dropVideo(v);
      } catch (e) { console.error(e); }
    })();
  }
  paintStrip(c);
}
function paintStrip(c) {
  const cv = $('strip'), box = $('trim');
  const Wd = Math.max(100, Math.round(box.clientWidth)), Hd = 56, dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Wd * dpr) { cv.width = Wd * dpr; cv.height = Hd * dpr; }
  const g = cv.getContext('2d'); g.fillStyle = '#E9E3D9'; g.fillRect(0, 0, cv.width, cv.height);
  const th = Hd * dpr, tw = th * c.w / c.h, n = Math.ceil(cv.width / tw);
  for (let i = 0; i < n; i++) {
    const f = c.frames && c.frames[Math.min(STRIP_N - 1, Math.floor((i + 0.5) / n * STRIP_N))];
    if (f) g.drawImage(f, i * tw, 0, tw, th);
  }
}

$('edTitle').addEventListener('input', (e) => { const c = selClip(); if (!c) return; c.title = e.target.value; edChanged('title'); });
$('edCap').addEventListener('input', (e) => { const c = selClip(); if (!c) return; c.caption = e.target.value; edChanged('caption'); });
$('edCapDur').addEventListener('change', (e) => { const c = selClip(); if (!c) return; c.capDur = clamp(+e.target.value || RULE.captionSec, 1, 12); edChanged('caption', 0); });
$('edCapHere').addEventListener('click', () => {
  const c = selClip(), m = mainOf(ed.plan); if (!c || !m) return;
  c.capStart = clamp(ed.T - m.start, 0, Math.max(0, m.dur - 1));
  edChanged('caption', 0);
});
const srcAt = () => { const m = mainOf(ed.plan); return m ? (m.trimIn || 0) + clamp(ed.T - m.start, 0, m.dur) : 0; };
function setTrim(c, a, b) {
  const dur = c.dur || 1;
  a = clamp(a, 0, dur - 0.5); b = clamp(b, a + 0.5, dur);
  c.trimIn = a < 0.05 ? 0 : a; c.trimOut = b > dur - 0.05 ? 0 : b;
}
$('trimA').addEventListener('input', (e) => { const c = selClip(); if (!c) return; setTrim(c, +e.target.value, c.trimOut || c.dur); edInspector(currentSelection()); edChanged('trimIn', 120); });
$('trimB').addEventListener('input', (e) => { const c = selClip(); if (!c) return; setTrim(c, c.trimIn || 0, +e.target.value); edInspector(currentSelection()); edChanged('trimOut', 120); });
$('trimIn').addEventListener('click', () => { const c = selClip(); if (!c) return; setTrim(c, srcAt(), c.trimOut || c.dur); edChanged('trimIn', 0); });
$('trimOut').addEventListener('click', () => { const c = selClip(); if (!c) return; setTrim(c, c.trimIn || 0, srcAt()); edChanged('trimOut', 0); });
$('trimReset').addEventListener('click', () => { const c = selClip(); if (!c) return; c.trimIn = 0; c.trimOut = 0; edChanged('trimIn', 0); });
$('edCrop').addEventListener('input', (e) => { const c = selClip(); if (!c) return; c.cropX = +e.target.value; $('edCropVal').textContent = Math.round(c.cropX * 100) + '%'; edChanged('keep', 60); });
$('edMake').addEventListener('click', () => {
  const sel = currentSelection(); if (!sel) return;
  withRun(async () => {
    const ok = await makeOne(sel.clip, sel.out, '이 편 만드는 중');
    setBar(ok ? 1 : 0);
    if (ok) setTimeout(() => setStatus('다 만들었어요. 아래 결과가 새것으로 바뀌었어요.'), 0);
  });
});
window.addEventListener('resize', () => { const s = currentSelection(); if (s && !$('editor').hidden) paintStrip(s.clip); });

// ================================================================ 스타일 고르기: 버튼마다 실제 모습 썸네일, 누르면 그 부분을 바로 재생
const SAMPLE_TITLE = '산책하러 가는 날';
// 멈춘 영상에서 새 위치의 그림이 실제로 준비될 때까지 (최대 0.6초)
const frameReady = (v) => new Promise((r) => { if (v.requestVideoFrameCallback) { v.requestVideoFrameCallback(() => r()); setTimeout(r, 600); } else setTimeout(r, 120); });
async function buildSwatches() {
  const W = 1920, H = 1080;
  await document.fonts.load('300 60px "Noto Sans KR"', 'TOSOONI 토순이 친구 ' + SAMPLE_TITLE).catch(() => {});
  await document.fonts.load('400 40px "Noto Sans KR"', '토순이 친구').catch(() => {});
  const shot = async (btn, draw, vert) => {
    const [w, h] = vert ? [1080, 1920] : [W, H];
    const big = document.createElement('canvas'); big.width = w; big.height = h;
    const g = big.getContext('2d'); g.fillStyle = RULE.ivory; g.fillRect(0, 0, w, h);
    try { await draw(g, w, h); } catch (e) { console.error(e); }
    const label = btn.dataset.label || btn.textContent.trim();
    btn.dataset.label = label;
    btn.innerHTML = '<canvas class="sw"></canvas><span class="sw-l"></span>';
    btn.querySelector('.sw-l').textContent = label;
    const sw = btn.querySelector('.sw'), sh = vert ? 180 : 101;
    sw.width = Math.round(sh * w / h) * 2; sw.height = sh * 2;
    const sg = sw.getContext('2d'); sg.imageSmoothingQuality = 'high'; sg.drawImage(big, 0, 0, sw.width, sw.height);
  };
  const frameOf = (src, t, title) => async (g, w, h) => {
    const v = await makeVideo(src, { muted: true }); await seekTo(v, Math.min(t, (v.duration || t) - 0.1)); await frameReady(v);
    drawAsset(g, v, w, h); if (title) drawGreenTitleText(g, w, h, 'h', title, 2.6); dropVideo(v);
  };
  const btn = (seg, v) => $(seg).querySelector(`button[data-v="${v}"]`);
  await shot(btn('themeSeg', 'classic'), (g, w, h) => drawClassicTitle(g, w, h, 'h', SAMPLE_TITLE, 2.2));
  await shot(btn('themeSeg', 'autumn'), (g, w, h) => drawAutumnTitle(g, w, h, 'h', SAMPLE_TITLE, 2.4));
  await shot(btn('themeSeg', 'botanical'), frameOf(ASSET.greenTitle.h, 2.6, SAMPLE_TITLE));
  await shot(btn('openingSeg', 'minimal'), (g, w, h) => drawMinimalIntro(g, w, h, 'h', '', 2.3));
  await shot(btn('openingSeg', 'intro4s'), frameOf(ASSET.opening.intro4s.h, 3.2));
  await shot(btn('openingSeg', 'official'), frameOf(ASSET.opening.official.h, 10.0));
  await shot(btn('openingSeg', 'botanical'), frameOf(ASSET.opening.botanical.h, 3.2));
  await shot(btn('openingSeg', 'none'), (g, w, h) => { g.strokeStyle = '#D8D1C4'; g.lineWidth = 3; g.beginPath(); g.moveTo(w * 0.44, h / 2); g.lineTo(w * 0.56, h / 2); g.stroke(); });
  await shot(btn('endingSeg', 'shorts'), async (g, w, h) => { const v = await makeVideo(ASSET.ending.v, { muted: true }); await seekTo(v, 1.6); await frameReady(v); drawAsset(g, v, w, h); dropVideo(v); }, true);
  await shot(btn('endingSeg', 'none'), (g, w, h) => { g.strokeStyle = '#D8D1C4'; g.lineWidth = 4; g.beginPath(); g.moveTo(w * 0.4, h / 2); g.lineTo(w * 0.6, h / 2); g.stroke(); }, true);
  paint('themeSeg', state.theme); paint('openingSeg', state.opening); paint('endingSeg', state.ending);
}
setTimeout(() => buildSwatches().catch((e) => console.error(e)), 300);

// 누른 스타일이 들어가는 부분만 바로 재생
// 누른 썸네일 안에서도 그대로 움직이게 (원본 비율 그대로, 남는 곳은 아이보리)
function liveSwatch(btn) {
  const sw = btn && btn.querySelector('.sw'); if (!sw) return { frame() {}, restore() {} };
  const keep = document.createElement('canvas'); keep.width = sw.width; keep.height = sw.height; keep.getContext('2d').drawImage(sw, 0, 0);
  const g = sw.getContext('2d');
  return {
    frame() {
      g.fillStyle = RULE.ivory; g.fillRect(0, 0, sw.width, sw.height);
      const k = Math.min(sw.width / screen.width, sw.height / screen.height), w = screen.width * k, h = screen.height * k;
      g.drawImage(screen, (sw.width - w) / 2, (sw.height - h) / 2, w, h);
    },
    restore() { g.clearRect(0, 0, sw.width, sw.height); g.drawImage(keep, 0, 0); },
  };
}
async function tasteStyle(key, btn) {
  const live = liveSwatch(btn);
  try { await tasteRun(key, live); } finally { live.restore(); }
}
async function tasteRun(key, live) {
  const sel = currentSelection();
  if (sel && sel.clip.status === 'ready') {
    const p = await ed.ready; if (!p || state.running) return;
    const m = mainOf(p), byRole = (r) => p.segs.find((x) => x.role === r);
    let a = 0, b = p.total;
    if (key === 'opening') { const o = byRole('opening'); if (!o) { a = 0; b = Math.min(p.total, 2); } else { a = 0; b = o.start + o.dur + 1.2; } }
    else if (key === 'theme') { const t = byRole('title') || byRole('pause'); a = t ? t.start : Math.max(0, (m ? m.start : 0) - 0.5); b = (m ? m.start : a) + 2.2; }
    else if (key === 'ending') { const e = byRole('ending'); a = e ? Math.max(0, e.start - 1.2) : Math.max(0, p.total - 2.5); b = p.total; }
    ed.T = a; edSeek(a);
    await playRange(a, b, undefined, () => live.frame());
    return;
  }
  // 아직 영상이 없으면 견본으로 앞부분만
  if (state.running) return;
  if (key === 'ending') {
    if (state.ending === 'none') return;
    const [W, H] = SIZE.v;
    await playRange(0, Infinity, { fmt: 'v', W, H, segs: [{ kind: 'asset', role: 'ending', src: ASSET.ending.v }], clip: null }, () => live.frame());
    return;
  }
  const fake = { id: 0, title: SAMPLE_TITLE, caption: '', w: 1920, h: 1080, dur: 10 };
  const p = buildPlan(fake, { kind: 'main', fmt: 'h' }, { noMain: true });
  if (!p.segs.length) return;
  $('stageEmpty').hidden = true;
  await playRange(0, Infinity, p, () => live.frame());
  $('stageEmpty').hidden = state.clips.length > 0;
}

// ================================================================ 유튜브 업로드 (구글 로그인 → YouTube Data API v3, 이어올리기 방식)
let gisP = null, ytToken = null;
function loadGis() {
  return (gisP ||= new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = 'https://accounts.google.com/gsi/client';
    sc.onload = res; sc.onerror = () => { gisP = null; rej(new Error('구글 로그인 도구를 불러오지 못했어요')); }; document.head.append(sc);
  }));
}
function getYtToken() {
  const cid = (window.TOSOONI_CONFIG || {}).googleClientId;
  if (!cid) return Promise.reject(new Error('아직 구글 연결 설정이 안 돼 있어요. 설정이 끝나면 바로 쓸 수 있어요.'));
  if (ytToken && ytToken.exp > Date.now() + 60000) return Promise.resolve(ytToken.value);
  return loadGis().then(() => new Promise((res, rej) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: cid,
      scope: 'https://www.googleapis.com/auth/youtube.upload',
      callback: (r) => {
        if (r.error) return rej(new Error('구글 로그인이 취소됐거나 실패했어요'));
        ytToken = { value: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
        res(ytToken.value);
      },
      error_callback: () => rej(new Error('구글 로그인 창이 닫혔어요. 팝업 차단을 꺼 주세요.')),
    });
    tc.requestAccessToken();
  }));
}
async function uploadToYouTube(li, blob, mime, shorts) {
  const msg = li.querySelector('.yt-msg'), bar = li.querySelector('.yt-bar'), go = li.querySelector('.yt-go');
  const say = (t) => { msg.textContent = t; };
  go.disabled = true;
  try {
    say('구글 로그인 중…');
    const token = await getYtToken();
    const meta = {
      snippet: {
        title: li.querySelector('.yt-title').value.trim().slice(0, 100) || '토순이 친구',
        description: li.querySelector('.yt-desc').value,
        tags: ['토순이친구', '반려토끼', '토끼'].concat(shorts ? ['Shorts'] : []),
        categoryId: '15',            // 반려동물/동물
        defaultLanguage: 'ko', defaultAudioLanguage: 'ko',
      },
      status: { privacyStatus: li.querySelector('.yt-privacy').value, selfDeclaredMadeForKids: li.querySelector('.yt-kids').checked },
    };
    const type = (mime || blob.type || 'video/mp4').split(';')[0];
    say('업로드 준비 중…');
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(blob.size) },
      body: JSON.stringify(meta),
    });
    if (!init.ok) throw new Error(await ytError(init));
    const loc = init.headers.get('Location');
    if (!loc) throw new Error('업로드 주소를 받지 못했어요');
    const res = await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', loc);
      x.setRequestHeader('Authorization', 'Bearer ' + token);
      x.setRequestHeader('Content-Type', type);
      x.upload.onprogress = (e) => { if (e.lengthComputable) { bar.style.width = (e.loaded / e.total * 100).toFixed(1) + '%'; say(`올리는 중… ${Math.round(e.loaded / e.total * 100)}%`); } };
      x.onload = () => (x.status >= 200 && x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error(ytErrorText(x.status, x.responseText))));
      x.onerror = () => reject(new Error('인터넷 연결이 끊겼어요. 다시 눌러 주세요.'));
      x.send(blob);
    });
    const link = shorts ? `https://youtube.com/shorts/${res.id}` : `https://youtu.be/${res.id}`;
    const priv = res.status && res.status.privacyStatus;
    msg.innerHTML = `올렸어요! <a href="${link}" target="_blank" rel="noopener">${link}</a> · 유튜브에서 처리하는 데 몇 분 걸릴 수 있어요.`
      + (priv && priv !== meta.status.privacyStatus ? ' 아직 심사 전인 앱이라 유튜브가 비공개로 올렸어요. 유튜브 스튜디오에서 공개로 바꿀 수 있어요.' : '');
    li.querySelector('.yt-open').textContent = '유튜브에 올림 ✓';
  } catch (e) {
    console.error(e); say(e.message || String(e)); go.disabled = false;
  }
}
async function ytError(r) { return ytErrorText(r.status, await r.text()); }
function ytErrorText(status, body) {
  let reason = '';
  try { const j = JSON.parse(body); reason = (j.error && (j.error.errors?.[0]?.reason || j.error.message)) || ''; } catch (e) {}
  if (status === 401) { ytToken = null; return '구글 로그인이 만료됐어요. 다시 눌러 주세요.'; }
  if (/quota/i.test(reason)) return '오늘 유튜브 업로드 한도를 다 썼어요. 내일 다시 해 주세요.';
  if (/youtubeSignupRequired/i.test(reason)) return '이 구글 계정에 유튜브 채널이 없어요. 채널이 있는 계정으로 로그인해 주세요.';
  if (/uploadLimitExceeded/i.test(reason)) return '이 채널의 하루 업로드 한도를 넘었어요.';
  return `업로드 실패 (${status}${reason ? ', ' + reason : ''})`;
}

refresh();
