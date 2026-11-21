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
function drawCaption(ctx, W, H, fmt, text, t) {
  if (!text) return;
  const a = Math.min(prog(t, 0.25, 0.6), 1 - prog(t, RULE.captionSec - 0.35, RULE.captionSec));
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
  const lp = easeOut(prog(t, 0.25, 0.95)), half = 110 * k * lp, hy = yc - 118 * k;
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
  if (ta > 0) { ctx.globalAlpha = out * ta; setFont(ctx, 300, 34 * k, 34 * k * 0.2); ctx.fillStyle = '#8E8B85'; centerText(ctx, '오늘은', cx, yc - 34 * k + (1 - ta) * 8, 34 * k * 0.2); }
  const ma = ease(prog(t, 0.95, 1.75));
  if (ma > 0 && text) {
    ctx.globalAlpha = out * ma;
    const lsR = 0.08 + 0.12 * (1 - ma);
    const px = fitPx(ctx, text, 300, 92 * k, W * (vert ? 0.82 : 0.6), lsR);
    ctx.fillStyle = '#2F2E2B';
    centerText(ctx, text, cx, yc + 64 * k + (1 - ma) * 10, px * lsR);
  }
  const fa = ease(prog(t, 1.35, 1.95));
  if (fa > 0) { ctx.globalAlpha = out * fa; setFont(ctx, 400, 21 * k, 21 * k * 0.38); ctx.fillStyle = '#BFA373'; centerText(ctx, '토순이 친구', cx, yc + 160 * k, 21 * k * 0.38); }
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
  const lp = easeOut(prog(t, 0.25, 0.95)), half = 110 * k * lp, hy = yc - 118 * k;
  if (lp > 0) { ctx.strokeStyle = AUTUMN.gold; ctx.lineWidth = 1.5 * k; ctx.beginPath(); ctx.moveTo(cx - 22 * k, hy); ctx.lineTo(cx - 22 * k - half, hy); ctx.moveTo(cx + 22 * k, hy); ctx.lineTo(cx + 22 * k + half, hy); ctx.stroke(); }
  const ha = prog(ts, 0.55, 0.8);
  if (ha > 0) { ctx.globalAlpha = out * ha; drawLeaf(ctx, { type: 'maple', color: AUTUMN.maple[1] }, cx, hy, 30 * k, 0.15); }
  const ta = ease(prog(t, 0.7, 1.3));
  if (ta > 0) { ctx.globalAlpha = out * ta; setFont(ctx, 300, 34 * k, 34 * k * 0.2); ctx.fillStyle = AUTUMN.sub; centerText(ctx, '오늘은', cx, yc - 34 * k + (1 - ta) * 8, 34 * k * 0.2); }
  const ma = ease(prog(t, 0.95, 1.75));
  if (ma > 0 && text) { ctx.globalAlpha = out * ma; const lsR = 0.08 + 0.12 * (1 - ma); const px = fitPx(ctx, text, 300, 92 * k, W * (vert ? 0.82 : 0.6), lsR); ctx.fillStyle = AUTUMN.ink; centerText(ctx, text, cx, yc + 64 * k + (1 - ma) * 10, px * lsR); }
  const fa = ease(prog(t, 1.35, 1.95));
  if (fa > 0) { ctx.globalAlpha = out * fa; setFont(ctx, 400, 21 * k, 21 * k * 0.38); ctx.fillStyle = AUTUMN.gold; centerText(ctx, '토순이 친구', cx, yc + 160 * k, 21 * k * 0.38); }
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
function buildPlan(clip, out) {
  const fmt = out.fmt, [W, H] = SIZE[fmt];
  const botan = state.theme === 'botanical', autumn = state.theme === 'autumn';
  const segs = [];
  const vertSrc = clip.h > clip.w;

  if (state.opening !== 'none') segs.push({ kind: 'asset', src: pickSrc(ASSET.opening[state.opening], fmt) });   // 가로·쇼츠 모두 오프닝부터
  const title = (clip.title || '').trim();
  if (title) {
    if (botan) segs.push({ kind: 'asset', role: 'title', src: pickSrc(ASSET.greenTitle, fmt), text: title });
    else if (autumn) segs.push({ kind: 'still', role: 'title', style: 'autumn', dur: AUTUMN.titleSec, text: title });
    else segs.push({ kind: 'still', role: 'title', dur: CLASSIC_TITLE_SEC, text: title });
  }
  const classic = !botan && !autumn;
  // 클래식: 오프닝 뒤 타이틀이 없으면 가운데 동그란 토순이 아이콘 카드로 한 번 쉬어 감
  if (classic && !title && segs.length) segs.push({ kind: 'still', style: 'icon', dur: ICON_CARD_SEC });
  const main = {
    kind: 'clip', src: clip.url, clip,
    mode: out.kind === 'crop' ? { cropX: clip.cropX } : (vertSrc && fmt === 'h') ? 'contain' : 'cover',
    caption: (clip.caption || '').trim(),
  };
  const intoMain = segs.length > 0;
  if (intoMain) { if (botan) segs[segs.length - 1].wipe = true; else if (autumn) main.leafIn = true; else main.fadeIn = RULE.fadeInFromIvory; }
  segs.push(main);
  if (fmt === 'v' && state.ending !== 'none') {
    const end = { kind: 'asset', src: ASSET.ending.v };
    if (botan) main.wipe = true; else end.xfade = RULE.shortsEndingXfade;
    segs.push(end);
  } else {
    main.fadeOut = RULE.fadeOutToIvory;
    if (classic) segs.push({ kind: 'still', style: 'icon', dur: ICON_CARD_SEC });   // 끝도 아이콘 카드로 깔끔하게 닫음
  }
  return { fmt, W, H, segs, clip, out };
}

// ================================================================ 재생/녹화 엔진
let stopFlag = false;
async function runPlan(plan, { record, onProgress }) {
  const { W, H, fmt, segs, clip } = plan;
  screen.width = W; screen.height = H;
  const ctx = sctx;
  keyer ||= new Keyer();
  const ac = getAudioCtx(); await ac.resume();
  await document.fonts.load('300 60px "Noto Sans KR"', 'TOSOONI 오늘은 토순이 친구' + segs.map((s) => (s.text || '') + (s.caption || '')).join(''));
  await document.fonts.load('400 40px "Noto Sans KR"', '토순이 친구' + segs.map((s) => s.caption || '').join(''));
  const cornerImg = await frameOverlay(fmt, W, H);

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

  // 소스 불러오기 + 시작 시각 계산
  let T0 = 0;
  for (const s of segs) {
    if (s.kind !== 'still') {
      s.el = await makeVideo(s.src);
      s.dur = s.el.duration;
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
    }
    s.start = Math.max(0, T0 - (s.xfade || 0));
    T0 = s.start + s.dur;
    if (s.wipe) {
      s.wipeEl = await makeVideo(pickSrc(ASSET.wipe, fmt));
      route(s.wipeEl, 1);
      s.wipeAt = T0 - ASSET.wipe.cut;
    }
  }
  const total = T0;

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

  // 한 장면 그리기
  const drawSeg = (s, T) => {
    const t = s.kind === 'still' ? T - s.start : s.el.currentTime;
    ctx.save();
    if (s.xfade) ctx.globalAlpha = clamp((T - s.start) / s.xfade);
    if (s.kind === 'still') (s.style === 'autumn' ? drawAutumnTitle : s.style === 'icon' ? drawIconCard : drawClassicTitle)(ctx, W, H, fmt, s.text, t);
    else if (s.kind === 'asset') {
      if (s.el.readyState >= 2) drawAsset(ctx, s.el, W, H);
      if (s.role === 'title') drawGreenTitleText(ctx, W, H, fmt, s.text, t);
    } else {
      if (state.grade && 'filter' in ctx) ctx.filter = 'sepia(0.07) saturate(1.04) brightness(1.01)';
      if (s.el.readyState >= 2) drawVideo(ctx, s.el, W, H, s.mode);
      ctx.filter = 'none';
      if (cornerImg) ctx.drawImage(cornerImg, 0, 0, W, H);
      const vis = 1 - (s.fadeIn ? 1 - clamp(t / s.fadeIn) : 0);
      if (state.watermark) drawWatermark(ctx, W, H, fmt, vis);
      drawCaption(ctx, W, H, fmt, s.caption, t);
      // 아이보리에서 열리고 / 아이보리로 닫힘
      let iv = 0;
      if (s.fadeIn) iv = Math.max(iv, 1 - clamp(t / s.fadeIn));
      if (s.fadeOut) iv = Math.max(iv, clamp((t - (s.dur - s.fadeOut)) / s.fadeOut));
      if (iv > 0) { ctx.globalAlpha *= iv; ctx.fillStyle = RULE.ivory; ctx.fillRect(0, 0, W, H); }
    }
    ctx.restore();
  };

  // 첫 프레임 그려 두고 시작
  ctx.fillStyle = RULE.ivory; ctx.fillRect(0, 0, W, H);
  if (rec) rec.start(1000);
  const t0 = performance.now() / 1000 + 0.05;
  await new Promise((resolve) => {
    let fin = false;
    const tick = () => {
      if (fin) return;
      const T = performance.now() / 1000 - t0;
      if (stopFlag || T >= total + 0.05) { fin = true; resolve(); return; }
      for (const s of segs) {
        if (s.audioEl && s.started && !s.stopped && Math.abs(s.audioEl.currentTime - s.el.currentTime) > 0.12) s.audioEl.currentTime = s.el.currentTime;
        if (s.el && !s.started && T >= s.start) { s.started = true; play(s.el); if (s.audioEl) play(s.audioEl); if (s.fadeOut) s.gain.gain.setTargetAtTime(0, ac.currentTime + Math.max(0, s.dur - s.fadeOut), s.fadeOut / 3); }
        if (s.el && s.started && !s.stopped && T >= s.start + s.dur + 0.1) { s.stopped = true; s.el.pause(); if (s.audioEl) s.audioEl.pause(); }
        if (s.wipeEl && !s.wipeStarted && T >= s.wipeAt) { s.wipeStarted = true; play(s.wipeEl); }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
      ctx.fillStyle = RULE.ivory; ctx.fillRect(0, 0, W, H);
      // 지금 보이는 장면들(교차 중이면 둘) 순서대로
      const live = segs.filter((s) => T >= s.start && (T < s.start + s.dur || s === segs[segs.length - 1]));
      for (const s of live) drawSeg(s, T);
      if (!live.length) { const prev = [...segs].reverse().find((s) => T >= s.start); if (prev) drawSeg(prev, T); }
      for (const s of segs) if (s.wipeStarted && !s.wipeEl.ended && s.wipeEl.readyState >= 2) ctx.drawImage(keyer.key(s.wipeEl), 0, 0, W, H);
      for (const s of segs) if (s.leafIn) drawAutumnTransition(ctx, W, H, T - s.start + AUTUMN.transCut);
      onProgress && onProgress(T, total);
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
  return { blob, mime, total };
}

// ================================================================ UI
function setStatus(t) { $('status').textContent = t; }
function setBar(p) { $('barFill').style.width = (clamp(p) * 100).toFixed(1) + '%'; }

function setupSeg(id, key) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || state.running) return;
    state[key] = b.dataset.v; refresh();
  });
}
setupSeg('themeSeg', 'theme'); setupSeg('openingSeg', 'opening'); setupSeg('endingSeg', 'ending');
for (const k of ['watermark', 'grade', 'frame', 'clean', 'muteHiss', 'normalize']) $(k).addEventListener('change', (e) => { state[k] = e.target.checked; refresh(); });

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
  document.querySelectorAll('.seg button, .check input, .clip-card input, .clip-card button').forEach((b) => { b.disabled = state.running; });
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
  const fmt = sel ? sel.out.fmt : 'h';
  const [W, H] = SIZE[fmt];
  $('stage').classList.toggle('vert', fmt === 'v');
  screen.width = W; screen.height = H;
  sctx.fillStyle = RULE.ivory; sctx.fillRect(0, 0, W, H);
  if (!sel || !sel.clip.thumb || !sel.clip.thumb.videoWidth) return;
  await document.fonts.load('300 30px "Noto Sans KR"', 'TOSOONI').catch(() => {});
  const corner = await frameOverlay(fmt, W, H).catch(() => null);
  if (tok !== stillTok || state.running) return;
  const c = sel.clip, vertSrc = c.h > c.w;
  const mode = sel.out.kind === 'crop' ? { cropX: c.cropX } : (vertSrc && fmt === 'h') ? 'contain' : 'cover';
  if (state.grade && 'filter' in sctx) sctx.filter = 'sepia(0.07) saturate(1.04) brightness(1.01)';
  drawVideo(sctx, c.thumb, W, H, mode);
  sctx.filter = 'none';
  if (corner) sctx.drawImage(corner, 0, 0, W, H);
  if (state.watermark) drawWatermark(sctx, W, H, fmt, 1);
  if (c.caption) drawCaption(sctx, W, H, fmt, c.caption.trim(), 1.5);
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
        <label class="mini">타이틀 카드 <small>"오늘은" 아래 큰 글씨. 비우면 바로 본편</small>
          <span class="title-row"><span class="title-pre">오늘은</span><input type="text" class="f-title" maxlength="24" placeholder="산책하러 가는 날" aria-label="${idx + 1}번 영상 타이틀 문구 (오늘은 다음에 올 말)"></span></label>
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
    fT.addEventListener('input', () => { c.title = fT.value; });
    const fC = li.querySelector('.f-cap'); fC.value = c.caption || '';
    fC.addEventListener('input', () => { c.caption = fC.value; select(c, 'main'); });
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
    if (c.caption && t < RULE.captionSec) drawCaption(bg, W, H, out.fmt, c.caption.trim(), 1.5);
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
      title: '', caption: '', cropShorts: false, cropX: 0.5,
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
  withRun(async () => {
    state.selected = { clipId: clip.id, kind };
    const out = outputsOf(clip).find((o) => o.kind === kind);
    $('stage').classList.toggle('vert', out.fmt === 'v');
    $('stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
    await runPlan(buildPlan(clip, out), { record: false, onProgress: (t, T) => { setBar(t / T); setStatus(`미리보기 ${fmtTime(t)} / ${fmtTime(T)}`); } });
    setBar(0);
  });
}

const results = [];
$('exportBtn').addEventListener('click', () => withRun(async () => {
  const jobs = [];
  for (const c of state.clips.filter((x) => x.status === 'ready')) for (const o of outputsOf(c)) jobs.push({ c, o });
  $('stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (let j = 0; j < jobs.length && !stopFlag; j++) {
    const { c, o } = jobs[j];
    if (state.clean && !c.prepFinished) {
      setStatus(`${c.name} 소리 다듬기가 끝나길 기다리는 중…`);
      await Promise.race([c.prepDone, sleep(5 * 60 * 1000)]);
      if (stopFlag) break;
    }
    state.selected = { clipId: c.id, kind: o.kind };
    $('stage').classList.toggle('vert', o.fmt === 'v');
    const r = await runPlan(buildPlan(c, o), { record: true, onProgress: (t, T) => { setBar(t / T); setStatus(`${j + 1}/${jobs.length}편 만드는 중 · ${c.name} · ${o.label} · ${fmtTime(t)} / ${fmtTime(T)}`); } });
    if (stopFlag || !r.blob) break;
    addResult(c, o, r);
  }
  setBar(stopFlag ? 0 : 1);
  if (!stopFlag) setTimeout(() => setStatus(`완성! 아래에서 ${jobs.length}편을 확인하고 내려받으세요`), 0);
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
  const title = (c.title || '').trim() ? `오늘은 ${c.title.trim()}` : '토순이 친구';
  li.innerHTML = `<video controls playsinline preload="metadata"></video>
    <div class="r-meta">
      <div class="name"></div><div class="sub"></div>
      <div class="r-actions"><a class="btn small" download>내려받기</a><button class="btn ghost small yt-open">유튜브에 올리기</button></div>
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
  if (shorts) li.classList.add('vert');
  ul.prepend(li);
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
