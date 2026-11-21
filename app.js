'use strict';
/* 토순이 친구 스튜디오
 * 올린 영상에 오프닝 → 타이틀 카드 → 본편(테두리) → 잎 전환 → 엔딩을 자동으로 입혀
 * 브라우저 안에서 그대로 녹화해 mp4(또는 webm)로 내보낸다. 서버 없음. */

// ---------------------------------------------------------------- assets
const A = 'assets/';
const ASSET = {
  opening: {
    official:  { h: A + 'opening-official.mp4', dur: 11.7 },
    intro4s:   { h: A + 'opening-intro4s.mp4', dur: 4.0 },
    botanical: { h: A + 'opening-botanical-16x9.mp4', v: A + 'opening-botanical-9x16.mp4', dur: 9.6 },
  },
  title: { h: A + 'title-16x9.mp4', v: A + 'title-9x16.mp4', dur: 5.0 },
  frame: {
    corner: { h: A + 'frame-corner-16x9.png', v: A + 'frame-corner-9x16.png' },
    full:   { h: A + 'frame-full-16x9.png',   v: A + 'frame-full-9x16.png' },
  },
  // cut = 화면이 잎으로 꽉 가려지는 순간 (README 기준)
  trans: {
    wipe:    { h: A + 'leaf-wipe-16x9.mp4',    v: A + 'leaf-wipe-9x16.mp4',    dur: 1.4, cut: 0.7 },
    curtain: { h: A + 'leaf-curtain-16x9.mp4', v: A + 'leaf-curtain-9x16.mp4', dur: 1.6, cut: 0.8 },
  },
  ending: { shorts: { v: A + 'ending-9x16.mp4', dur: 2.6 } },
};
const pickSrc = (entry, fmt) => entry[fmt] || entry.h || entry.v;
const SIZE = { h: [1920, 1080], v: [1080, 1920] };
const TARGET_LUFS = -14;

// ---------------------------------------------------------------- state
const state = {
  clips: [],          // {id, file, url, name, w, h, dur}
  format: 'h', formatTouched: false,
  opening: 'official', openingTouched: false,
  title: '',
  frame: 'corner',
  trans: 'wipe',
  ending: 'shorts',
  normalize: true, clipAudio: true, sfx: true,
  running: false,
};
let clipSeq = 0;

const $ = (id) => document.getElementById(id);
const screen = $('screen');
const sctx = screen.getContext('2d');

// ---------------------------------------------------------------- helpers
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const prog = (t, a, b) => clamp((t - a) / (b - a));
const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('이미지를 불러오지 못했어요: ' + src));
    im.src = src;
  });
}

function makeVideo(src, { muted = false } = {}) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.playsInline = true;
    v.muted = muted;
    v.crossOrigin = 'anonymous';
    v.src = src;
    const done = () => { cleanup(); res(v); };
    const fail = () => { cleanup(); rej(new Error('영상을 열지 못했어요. 이 브라우저가 지원하지 않는 형식일 수 있어요.')); };
    const cleanup = () => { v.removeEventListener('loadeddata', done); v.removeEventListener('error', fail); };
    v.addEventListener('loadeddata', done);
    v.addEventListener('error', fail);
    v.load();
  });
}

const imgCache = new Map();
function frameImage(kind, fmt) {
  if (kind === 'none') return Promise.resolve(null);
  const src = pickSrc(ASSET.frame[kind], fmt);
  if (!imgCache.has(src)) imgCache.set(src, loadImage(src));
  return imgCache.get(src);
}

// 영상을 캔버스 비율에 맞추기: 비율이 같으면 꽉 채우고(cover),
// 다르면 가운데에 온전히 두고(contain) 양옆/위아래는 같은 화면을 흐리게 깔아 채운다.
const blurCv = document.createElement('canvas');
const blurCtx = blurCv.getContext('2d', { willReadFrequently: true });
function drawFit(ctx, src, W, H, fill = 'blur') {
  const vw = src.videoWidth || src.naturalWidth || src.width;
  const vh = src.videoHeight || src.naturalHeight || src.height;
  if (!vw || !vh) return;
  const ra = vw / vh, rc = W / H;
  if (Math.abs(ra - rc) / rc < 0.04) {
    const s = Math.max(W / vw, H / vh);
    const dw = vw * s, dh = vh * s;
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return;
  }
  // 흐린 배경: 아주 작게 그렸다가 크게 늘리면 부드럽게 번진다
  const bw = 40, bh = Math.round(40 * H / W);
  if (blurCv.width !== bw || blurCv.height !== bh) { blurCv.width = bw; blurCv.height = bh; }
  const s0 = Math.max(bw / vw, bh / vh);
  blurCtx.drawImage(src, (bw - vw * s0) / 2, (bh - vh * s0) / 2, vw * s0, vh * s0);
  ctx.save();
  if (fill === 'edge') {
    // 토순이 에셋(종이 배경)은 가장자리 색으로 깔끔하게 채운다
    const d = blurCtx.getImageData(0, 0, 1, bh).data;
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < d.length; k += 4) { r += d[k]; g += d[k + 1]; b += d[k + 2]; }
    const n = d.length / 4;
    ctx.fillStyle = `rgb(${r / n | 0},${g / n | 0},${b / n | 0})`;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(blurCv, 0, 0, W, H);
    ctx.fillStyle = 'rgba(247,243,236,0.18)';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
  const s = Math.min(W / vw, H / vh);
  const dw = vw * s, dh = vh * s;
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

// 타이틀 카드 큰 글씨: 템플릿 원본 렌더러(botanical-template-source.html)와 같은 위치·크기·움직임
function fitFont(ctx, txt, px, weight, maxW, ls) {
  let s = px;
  const apply = () => {
    ctx.font = `${weight} ${s}px "Noto Sans KR"`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = ls(s) + 'px';
  };
  apply();
  while (ctx.measureText(txt).width > maxW && s > 20) { s -= 1; apply(); }
  return s;
}
function drawTitleText(ctx, text, t, fmt, W, H) {
  if (!text) return;
  const vert = fmt === 'v';
  const k = W / (vert ? 720 : 1280);
  const lw = W / k, lh = H / k;
  const ma = ease(prog(t, 1.2, 2.0));
  if (ma <= 0) return;
  ctx.save();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = ma;
  fitFont(ctx, text, 62, 300, vert ? lw * 0.76 : lw * 0.58, (s) => s * (0.1 + 0.18 * (1 - ma)));
  ctx.fillStyle = '#F5EFE3';
  const yc = lh * (vert ? 0.47 : 0.5);
  ctx.fillText(text, lw / 2, yc + 44 + (1 - ma) * 10);
  ctx.restore();
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

// ---------------------------------------------------------------- chroma key (블루스크린 전환 → 투명)
class Keyer {
  constructor() {
    this.c = document.createElement('canvas');
    const gl = this.c.getContext('webgl', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true });
    this.gl = gl;
    if (!gl) { this.c2 = this.c.getContext('2d', { willReadFrequently: true }); return; }
    const vs = `attribute vec2 p;varying vec2 v;void main(){v=p*0.5+0.5;gl_Position=vec4(p,0.,1.);}`;
    const fs = `precision mediump float;varying vec2 v;uniform sampler2D u;
      void main(){vec4 c=texture2D(u,v);float m=max(c.r,c.g);float d=c.b-m;
      float a=1.0-smoothstep(0.16,0.5,d);vec3 col=c.rgb;col.b=min(col.b,m+0.05);
      gl_FragColor=vec4(col*a,a);}`;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(pr);
    gl.useProgram(pr);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }
  key(video) {
    const w = video.videoWidth, h = video.videoHeight;
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; }
    const gl = this.gl;
    if (gl) {
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return this.c;
    }
    // WebGL이 없을 때: 느리지만 같은 계산
    const g = this.c2;
    g.drawImage(video, 0, 0, w, h);
    const im = g.getImageData(0, 0, w, h), d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
      const m = Math.max(r, gg), x = clamp((b - m - 0.16) / 0.34);
      const a = 1 - x * x * (3 - 2 * x);
      d[i + 2] = Math.min(b, m + 0.05) * 255;
      d[i + 3] = a * 255;
    }
    g.putImageData(im, 0, 0);
    return this.c;
  }
}
let keyer = null;

// ---------------------------------------------------------------- loudness (-14 LUFS)
// ITU-R BS.1770 방식의 근사치: K-weighting 필터 → 400ms 블록 → 절대(-70)/상대(-10) 게이트
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
const lufsCache = new Map();
function measureLufs(key, getBuffer) {
  if (lufsCache.has(key)) return lufsCache.get(key);
  const p = (async () => {
    try {
      const ab = await getBuffer();
      if (!ab) return null;
      const audio = await getAudioCtx().decodeAudioData(ab);
      const sr = audio.sampleRate;
      const oac = new OfflineAudioContext(audio.numberOfChannels, audio.length, sr);
      const src = oac.createBufferSource();
      src.buffer = audio;
      const shelf = oac.createBiquadFilter();
      shelf.type = 'highshelf'; shelf.frequency.value = 1681.97; shelf.gain.value = 4.0;
      const hp = oac.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 38.13; hp.Q.value = 0.5;
      src.connect(shelf).connect(hp).connect(oac.destination);
      src.start();
      const out = await oac.startRendering();
      const block = Math.round(sr * 0.4), step = Math.round(sr * 0.1);
      const chans = [];
      for (let c = 0; c < Math.min(out.numberOfChannels, 2); c++) chans.push(out.getChannelData(c));
      const zs = [];
      for (let s = 0; s + block <= out.length; s += step) {
        let sum = 0;
        for (const ch of chans) {
          let acc = 0;
          for (let i = s; i < s + block; i++) acc += ch[i] * ch[i];
          sum += acc / block;
        }
        zs.push(sum);
      }
      const L = (z) => -0.691 + 10 * Math.log10(z);
      const abs = zs.filter((z) => z > 0 && L(z) > -70);
      if (!abs.length) return null;
      const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
      const gated = abs.filter((z) => L(z) > rel);
      if (!gated.length) return null;
      // 모노 소리는 재생할 때 양쪽 스피커로 똑같이 나가므로 +3dB
      return L(gated.reduce((a, b) => a + b, 0) / gated.length) + (out.numberOfChannels === 1 ? 3.01 : 0);
    } catch (e) {
      console.warn('[loudness] 측정 실패', key, e);
      return null; // 소리가 없거나 디코딩 불가 → 원래 음량 그대로
    }
  })();
  lufsCache.set(key, p);
  return p;
}
const lufsOfUrl = (url) => measureLufs(url, async () => (await fetch(url)).arrayBuffer());
const lufsOfClip = (clip) => measureLufs('clip:' + clip.id, async () =>
  clip.file.size > 700 * 1024 * 1024 ? null : clip.file.arrayBuffer());
const gainFor = (lufs) => (lufs == null ? 1 : clamp(Math.pow(10, (TARGET_LUFS - lufs) / 20), 0.05, 8));

// ---------------------------------------------------------------- plan
function buildPlan() {
  const fmt = state.format;
  const segs = [];
  if (state.opening !== 'none') {
    const o = ASSET.opening[state.opening];
    segs.push({ kind: 'opening', src: pickSrc(o, fmt), dur: o.dur });
  }
  const title = state.title.trim();
  if (title) segs.push({ kind: 'title', src: pickSrc(ASSET.title, fmt), dur: ASSET.title.dur, text: title });
  for (const c of state.clips) segs.push({ kind: 'clip', src: c.url, dur: c.dur, clip: c });
  if (state.ending !== 'none') {
    const e = ASSET.ending[state.ending];
    segs.push({ kind: 'ending', src: pickSrc(e, fmt), dur: e.dur });
  }
  // 경계마다 전환. 오프닝 → 타이틀은 바로 이어짐(타이틀이 스스로 열리는 애니메이션이라)
  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i], b = segs[i + 1];
    if (state.trans === 'none' || (a.kind === 'opening' && b.kind === 'title')) continue;
    const tr = ASSET.trans[state.trans];
    a.out = { src: pickSrc(tr, fmt), dur: tr.dur, cut: tr.cut };
  }
  const total = segs.reduce((s, x) => s + (x.dur || 0), 0);
  return { fmt, W: SIZE[fmt][0], H: SIZE[fmt][1], segs, total };
}

// ---------------------------------------------------------------- engine
let stopFlag = false;

async function runPlan(plan, { record }) {
  const { W, H, fmt, segs } = plan;
  screen.width = W; screen.height = H;
  const ctx = sctx;
  if (!keyer) keyer = new Keyer();

  setStatus('준비하는 중…');
  const ac = getAudioCtx();
  await ac.resume();

  // 글꼴, 테두리, 음량 측정
  const fontP = document.fonts.load('300 93px "Noto Sans KR"', segs.map((s) => s.text || '').join('') || '토순이');
  const frameImg = await frameImage(state.frame, fmt);
  await fontP.catch(() => {});

  if (state.normalize) {
    setStatus('음량을 재는 중… (영상이 길면 조금 걸려요)');
    await Promise.all(segs.map(async (s) => {
      s.lufs = s.kind === 'clip' ? await lufsOfClip(s.clip) : await lufsOfUrl(s.src);
    }));
  }

  // 오디오 그래프: 각 영상 → 음량 → 마스터 → 리미터 → 스피커(+녹음)
  const master = ac.createGain();
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.002; limiter.release.value = 0.12;
  master.connect(limiter);
  limiter.connect(ac.destination);
  const dest = record ? ac.createMediaStreamDestination() : null;
  if (dest) limiter.connect(dest);
  const nodes = [];
  const route = (el, gain) => {
    const src = ac.createMediaElementSource(el);
    const g = ac.createGain();
    g.gain.value = gain;
    src.connect(g).connect(master);
    nodes.push(src, g);
  };

  setStatus('영상을 불러오는 중…');
  for (const s of segs) {
    s.el = await makeVideo(s.src);
    if (isFinite(s.el.duration) && s.el.duration > 0) s.dur = s.el.duration;
    let g = state.normalize ? gainFor(s.lufs) : 1;
    if (s.kind === 'clip' && !state.clipAudio) g = 0;
    route(s.el, g);
    if (s.out) {
      s.out.el = await makeVideo(s.out.src);
      route(s.out.el, state.sfx ? 1 : 0);
    }
  }
  const total = segs.reduce((a, s) => a + s.dur, 0);

  // 녹화 준비
  let rec = null, chunks = [], mime = '';
  if (record) {
    const stream = screen.captureStream(30);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const cands = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
      'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    mime = cands.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    if (!window.MediaRecorder) throw new Error('이 브라우저는 영상 저장을 지원하지 않아요. 크롬 최신 버전으로 열어 주세요.');
    rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 192_000 });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  }

  const playEl = async (el) => {
    try { await el.play(); }
    catch (e) { el.muted = true; await el.play().catch(() => {}); }
  };

  // 재생 루프
  let i = 0, doneTime = 0;
  const overlays = [];
  const drawFrame = () => {
    const s = segs[i];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (s.el.readyState >= 2) drawFit(ctx, s.el, W, H, s.kind === 'clip' ? 'blur' : 'edge');
    if (s.kind === 'clip' && frameImg) ctx.drawImage(frameImg, 0, 0, W, H);
    if (s.kind === 'title') drawTitleText(ctx, s.text, s.el.currentTime, fmt, W, H);
    for (const o of overlays) {
      if (o.el.ended || o.el.readyState < 2) continue;
      ctx.drawImage(keyer.key(o.el), 0, 0, W, H);
    }
  };

  // 첫 화면을 그려 두고 시작
  drawFrame();
  if (rec) rec.start(1000);
  await playEl(segs[0].el);

  await new Promise((resolve) => {
    let finished = false;
    const tick = () => {
      if (finished) return;
      if (stopFlag) { finished = true; resolve(); return; }
      const s = segs[i];
      const t = s.el.currentTime;
      // 전환 시작: 잎이 화면을 꽉 덮는 순간이 컷 지점에 오도록
      if (s.out && !s.out.started && (t >= s.dur - s.out.cut || s.el.ended)) {
        s.out.started = true;
        overlays.push(s.out);
        playEl(s.out.el);
      }
      // 다음 장면으로
      if (s.el.ended || t >= s.dur - 0.02) {
        if (i + 1 < segs.length) {
          doneTime += s.dur;
          s.el.pause();
          i++;
          playEl(segs[i].el);
        } else if (overlays.every((o) => o.el.ended)) {
          drawFrame();
          finished = true;
          resolve();
          return;
        }
      }
      drawFrame();
      const now = doneTime + Math.min(segs[i].el.currentTime, segs[i].dur);
      setProgress(now / total, `${record ? '만드는 중' : '미리보기'} ${fmtTime(now)} / ${fmtTime(total)}`);
      schedule(tick);
    };
    schedule(tick);
  });

  // 정리
  for (const s of segs) { s.el.pause(); if (s.out && s.out.el) s.out.el.pause(); }
  let blob = null;
  if (rec) {
    await sleep(150);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.stop();
    await stopped;
    blob = new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] });
  }
  try { limiter.disconnect(); master.disconnect(); nodes.forEach((n) => n.disconnect()); } catch (e) {}
  for (const s of segs) { s.el.removeAttribute('src'); s.el.load(); if (s.out && s.out.el) { s.out.el.removeAttribute('src'); s.out.el.load(); } }
  return { blob, mime, total };
}

// 탭이 가려지면 rAF가 멈추므로 타이머로 대신 돈다
function schedule(fn) {
  if (document.hidden) setTimeout(fn, 1000 / 30);
  else requestAnimationFrame(fn);
}

// ---------------------------------------------------------------- UI
function setStatus(txt) { $('status').textContent = txt; }
function setProgress(p, txt) {
  $('barFill').style.width = (clamp(p) * 100).toFixed(1) + '%';
  if (txt) setStatus(txt);
}

function setupSeg(id, key, onChange) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled || state.running) return;
    state[key] = b.dataset.v;
    if (onChange) onChange(b.dataset.v);
    refresh();
  });
}
function paintSeg(id, val) {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === val);
}

setupSeg('formatSeg', 'format', () => { state.formatTouched = true; applyFormatDefaults(); });
setupSeg('openingSeg', 'opening', () => { state.openingTouched = true; });
setupSeg('frameSeg', 'frame');
setupSeg('transSeg', 'trans');
setupSeg('endingSeg', 'ending');
$('titleText').addEventListener('input', (e) => { state.title = e.target.value; refresh(); });
for (const k of ['normalize', 'clipAudio', 'sfx']) $(k).addEventListener('change', (e) => { state[k] = e.target.checked; });

function applyFormatDefaults() {
  // 세로 쇼츠는 세로 전용으로 만든 보태니컬 오프닝이 기본, 가로는 공식 오프닝
  if (!state.openingTouched) state.opening = state.format === 'v' ? 'botanical' : 'official';
}

function refresh() {
  paintSeg('formatSeg', state.format);
  paintSeg('openingSeg', state.opening);
  paintSeg('frameSeg', state.frame);
  paintSeg('transSeg', state.trans);
  paintSeg('endingSeg', state.ending);
  $('endingNote').hidden = !(state.format === 'h' && state.ending === 'shorts');
  $('formatLine').hidden = state.clips.length === 0;
  $('stage').classList.toggle('vert', state.format === 'v');
  $('stageEmpty').hidden = state.clips.length > 0;
  const busy = state.clips.some((c) => c.converting || c.failed);
  const has = state.clips.length > 0 && !busy;
  $('previewBtn').disabled = !has || state.running;
  $('exportBtn').disabled = !has || state.running;
  $('stopBtn').hidden = !state.running;
  document.querySelectorAll('.seg button, #titleText, .icon-btn, .check input').forEach((b) => { b.disabled = state.running; });
  if (!state.running) {
    if (state.clips.some((c) => c.failed)) {
      setProgress(0, '변환하지 못한 영상이 있어요. 목록에서 빼고 다시 해 주세요.');
    } else if (busy) {
      setProgress(0, '영상을 변환하는 중이에요. 끝나면 미리보기와 영상 만들기를 누를 수 있어요.');
    } else if (has) {
      const plan = buildPlan();
      setProgress(0, `총 길이 약 ${fmtTime(plan.total)} · ${state.format === 'v' ? '세로 1080×1920' : '가로 1920×1080'} · 30fps`);
    } else setProgress(0, '총 길이 계산 전');
    drawStill();
  }
}

// 멈춰 있을 때 보여주는 한 장면: 첫 영상 + 테두리
let stillToken = 0;
async function drawStill() {
  const token = ++stillToken;
  const [W, H] = SIZE[state.format];
  screen.width = W; screen.height = H;
  sctx.fillStyle = '#ECE7DF';
  sctx.fillRect(0, 0, W, H);
  const c = state.clips[0];
  if (!c || !c.thumb) return;
  const img = await frameImage(state.frame, state.format).catch(() => null);
  if (token !== stillToken || state.running) return;
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, W, H);
  drawFit(sctx, c.thumb, W, H);
  if (img) sctx.drawImage(img, 0, 0, W, H);
}

function renderClipList() {
  const ul = $('clipList');
  ul.innerHTML = '';
  state.clips.forEach((c, idx) => {
    const li = document.createElement('li');
    const v = document.createElement('video');
    v.src = c.url; v.muted = true; v.preload = 'metadata'; v.playsInline = true;
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); });
    const meta = document.createElement('div');
    meta.className = 'meta';
    const orient = c.h > c.w ? '세로' : '가로';
    meta.innerHTML = `<div class="name"></div><div class="sub">${idx + 1}번 · ${fmtTime(c.dur)}${c.w ? ` · ${orient} ${c.w}×${c.h}` : ''}</div><div class="sub warn" hidden></div>`;
    meta.querySelector('.name').textContent = c.name;
    if (c.note) { const w = meta.querySelector('.warn'); w.hidden = false; w.textContent = c.note; c.noteEl = w; }
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    const mk = (label, title, fn, dis) => {
      const b = document.createElement('button');
      b.className = 'icon-btn'; b.textContent = label; b.title = title; b.disabled = dis || state.running;
      b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
      return b;
    };
    ctl.append(
      mk('↑', '앞으로', () => { [state.clips[idx - 1], state.clips[idx]] = [state.clips[idx], state.clips[idx - 1]]; renderClipList(); refresh(); }, idx === 0),
      mk('↓', '뒤로', () => { [state.clips[idx + 1], state.clips[idx]] = [state.clips[idx], state.clips[idx + 1]]; renderClipList(); refresh(); }, idx === state.clips.length - 1),
      mk('✕', '빼기', () => { URL.revokeObjectURL(c.url); state.clips.splice(idx, 1); renderClipList(); refresh(); }),
    );
    li.append(v, meta, ctl);
    ul.append(li);
  });
}

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
  if (!list.length) return;
  setStatus('영상을 읽는 중…');
  for (const file of list) {
    const url = URL.createObjectURL(file);
    try {
      const v = await makeVideo(url, { muted: true });
      v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
      await new Promise((r) => { v.onseeked = r; setTimeout(r, 1500); });
      const clip = { id: ++clipSeq, file, url, name: file.name, w: v.videoWidth, h: v.videoHeight, dur: v.duration, thumb: v };
      state.clips.push(clip);
      if (!v.videoWidth) {
        // 소리만 읽히고 화면은 못 읽는 영상(대개 아이폰·갤럭시 고효율 HEVC) → 자동 변환
        clip.converting = true;
        clip.note = '이 브라우저가 읽을 수 없는 형식이라 변환을 기다리는 중…';
        convertQueue = convertQueue.then(() => convertClip(clip));
      } else if (state.normalize) lufsOfClip(clip); // 미리 재 두기
    } catch (e) {
      URL.revokeObjectURL(url);
      alertNote(`"${file.name}"을(를) 열지 못했어요. 아이폰 HEVC 영상이라면 크롬 대신 사파리에서 열거나, 호환 형식(H.264)으로 저장해 주세요.`);
    }
  }
  // 첫 영상의 방향으로 화면 비율 자동 결정
  if (!state.formatTouched && state.clips.length) {
    const c = state.clips[0];
    if (c.w) state.format = c.h > c.w ? 'v' : 'h';
    applyFormatDefaults();
    $('autoNote').textContent = `첫 영상이 ${state.format === 'v' ? '세로' : '가로'}라서 자동으로 골랐어요`;
  }
  renderClipList();
  refresh();
}

function alertNote(msg) { setStatus(msg); }

// ---------------------------------------------------------------- 변환 (ffmpeg.wasm, 필요할 때만 불러옴)
let convertQueue = Promise.resolve();
let ffmpegP = null;
function loadFFmpeg() {
  if (!ffmpegP) ffmpegP = (async () => {
    await new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'vendor/ffmpeg/ffmpeg.js';
      sc.onload = res;
      sc.onerror = () => rej(new Error('변환 도구를 불러오지 못했어요'));
      document.head.append(sc);
    });
    const ff = new FFmpegWASM.FFmpeg();
    const base = new URL('vendor/ffmpeg/', location.href).href;
    await ff.load({ coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm' });
    return ff;
  })().catch((e) => { ffmpegP = null; throw e; });
  return ffmpegP;
}
function clipNote(clip, txt) {
  clip.note = txt;
  if (clip.noteEl) { clip.noteEl.hidden = !txt; clip.noteEl.textContent = txt; }
}
async function convertClip(clip) {
  if (!state.clips.includes(clip)) return;
  try {
    clipNote(clip, '변환 도구를 불러오는 중… (처음 한 번만 30MB 정도 받아요)');
    const ff = await loadFFmpeg();
    clipNote(clip, '읽을 수 있는 형식으로 바꾸는 중… 0%');
    const onProg = ({ progress }) => clipNote(clip, `읽을 수 있는 형식으로 바꾸는 중… ${Math.round(clamp(progress) * 100)}%`);
    ff.on('progress', onProg);
    const ext = (clip.name.match(/\.\w+$/) || ['.mov'])[0];
    await ff.writeFile('in' + ext, new Uint8Array(await clip.file.arrayBuffer()));
    // 긴 변이 1920을 넘지 않게 줄이고, 30fps H.264로
    await ff.exec(['-i', 'in' + ext,
      '-vf', "scale='if(gte(iw,ih),min(1920,iw),-2)':'if(gte(iw,ih),-2,min(1920,ih))',fps=30,format=yuv420p",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'out.mp4']);
    ff.off('progress', onProg);
    const data = await ff.readFile('out.mp4');
    await ff.deleteFile('in' + ext).catch(() => {});
    await ff.deleteFile('out.mp4').catch(() => {});
    const file = new File([data], clip.name.replace(/\.\w+$/, '') + '.mp4', { type: 'video/mp4' });
    const url = URL.createObjectURL(file);
    const v = await makeVideo(url, { muted: true });
    if (!v.videoWidth) throw new Error('변환 후에도 화면을 읽지 못했어요');
    v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
    URL.revokeObjectURL(clip.url);
    Object.assign(clip, { file, url, w: v.videoWidth, h: v.videoHeight, dur: v.duration, thumb: v, converting: false });
    lufsCache.delete('clip:' + clip.id);
    clipNote(clip, '');
    if (!state.formatTouched && state.clips[0] === clip) { state.format = clip.h > clip.w ? 'v' : 'h'; applyFormatDefaults(); }
    if (state.normalize) lufsOfClip(clip);
  } catch (e) {
    console.error(e);
    Object.assign(clip, { converting: false, failed: true });
    clipNote(clip, '변환하지 못했어요. 휴대폰에서 "호환성 우선"(H.264)으로 저장해 다시 올려 주세요.');
  }
  renderClipList();
  refresh();
}

$('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

async function start(record) {
  if (state.running || !state.clips.length) return;
  state.running = true;
  stopFlag = false;
  $('result').hidden = true;
  refresh();
  try {
    const plan = buildPlan();
    const out = await runPlan(plan, { record });
    if (stopFlag) setProgress(0, '멈췄어요');
    else if (record && out.blob) showResult(out);
    else setProgress(1, '미리보기 끝');
  } catch (e) {
    console.error(e);
    setProgress(0, '문제가 생겼어요: ' + (e.message || e));
  } finally {
    state.running = false;
    refresh();
    if (!stopFlag && record) setProgress(1, '완성! 아래에서 확인하고 내려받으세요');
  }
}

let lastUrl = null;
function showResult({ blob, mime }) {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);
  const isMp4 = (mime || '').startsWith('video/mp4');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const name = `tosooni-${state.format === 'v' ? 'shorts' : 'video'}-${stamp}.${isMp4 ? 'mp4' : 'webm'}`;
  $('resultVideo').src = lastUrl;
  const a = $('downloadLink');
  a.href = lastUrl; a.download = name;
  a.textContent = `내려받기 (${(blob.size / 1048576).toFixed(1)}MB)`;
  $('resultNote').textContent = isMp4
    ? `${name} · 유튜브에 바로 올릴 수 있어요.`
    : `${name} · 이 브라우저는 mp4 저장을 지원하지 않아 webm으로 만들었어요. 유튜브에는 그대로 올려도 돼요.`;
  $('result').hidden = false;
}

$('previewBtn').addEventListener('click', () => start(false));
$('exportBtn').addEventListener('click', () => start(true));
$('stopBtn').addEventListener('click', () => { stopFlag = true; });

applyFormatDefaults();
refresh();
