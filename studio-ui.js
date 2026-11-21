'use strict';
/* 토순이 친구 스튜디오 — 화면 감성 업그레이드
   1) 원클릭 프리셋 알약 + 토순이 말풍선 가이드
   2) 미니 토순이·당근 커서 (style.css 안의 SVG 커서)
   3) 호버 컬러 리빌 · 미리보기 컬러 스포트라이트와 '보정 전' 비교

   app.js의 state·인코딩·DOM ID·이벤트 흐름은 건드리지 않아요.
   이미 있는 버튼을 눌러 주고, 화면 상태를 읽어서 안내만 바꾸는 방식이에요.
   비교용 '보정 전' 그림은 화면 위에 따로 얹은 캔버스에만 그려서,
   만들어지는 영상 픽셀(내보내기 캔버스)에는 손대지 않아요. */
(function () {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const screenCv = $('screen');
  const clipList = $('clipList');
  const presetRow = $('presetRow');
  const guideText = $('guideText');
  if (!stage || !screenCv || !presetRow || !guideText) return;
  const bubble = guideText.parentElement;

  // ---------------------------------------------------------------- 공통
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const isRunning = () => { const b = $('stopBtn'); return !!b && !b.hidden; };
  const segValue = (id) => { const b = $(id) && $(id).querySelector('button.on'); return b ? b.dataset.v : null; };

  // ---------------------------------------------------------------- 1. 프리셋 + 말풍선 가이드
  const PRESETS = {
    shorts: {
      set: { theme: 'classic', opening: 'intro4s', ending: 'shorts', watermark: true },
      say: '세로 쇼츠는 크림 카드로 맞췄어! 세로 영상은 위아래 안 잘리게 1080×1920으로 담을게.',
    },
    vlog: {
      set: { theme: 'classic', opening: 'official', ending: 'none', watermark: true },
      say: '가로 브이로그는 공식 오프닝으로 천천히 열고, 끝은 담백하게 끊을게.',
    },
    caption: {
      set: { theme: 'classic', opening: 'none', ending: 'none', watermark: false },
      say: '오프닝·엔딩·로고는 빼고, 영상마다 적어 준 제목과 자막만 얹을게!',
    },
    autumn: {
      set: { theme: 'autumn', opening: 'intro4s', ending: 'shorts', watermark: true },
      say: '가을 테마! 크림 종이에 낙엽이 쏟아지며 넘어가. 따뜻한 결로 맞춰 볼까?',
    },
  };
  const PRESET_KEYS = Object.keys(PRESETS);

  function activePreset() {
    const theme = segValue('themeSeg'), opening = segValue('openingSeg'), ending = segValue('endingSeg');
    const wm = $('watermark');
    for (let i = 0; i < PRESET_KEYS.length; i++) {
      const k = PRESET_KEYS[i], s = PRESETS[k].set;
      if (theme !== s.theme || opening !== s.opening || ending !== s.ending) continue;
      if (wm && wm.checked !== s.watermark) continue;
      return k;
    }
    return null;
  }

  function markPresets() {
    const on = activePreset();
    presetRow.querySelectorAll('.preset').forEach((b) => {
      const isOn = b.dataset.preset === on;
      b.classList.toggle('on', isOn);
      b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    });
  }

  function setSeg(id, v) {
    const b = $(id) && $(id).querySelector('button[data-v="' + v + '"]');
    if (b && !b.classList.contains('on') && !b.disabled) b.click();
  }
  function setCheckbox(id, v) {
    const el = $(id);
    if (!el || el.checked === v) return;
    el.checked = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function applyPreset(key) {
    const p = PRESETS[key];
    if (!p || isRunning()) return;
    hoverSay = null;
    setSeg('themeSeg', p.set.theme);
    setSeg('openingSeg', p.set.opening);
    setSeg('endingSeg', p.set.ending);
    setCheckbox('watermark', p.set.watermark);
    markPresets();
    say(guideLine());
  }

  let hoverSay = null;
  let shown = '';
  let swapTok = 0;
  function say(text) {
    if (!text || text === shown) return;
    shown = text;
    const tok = ++swapTok;
    bubble.classList.add('swap');
    setTimeout(() => {
      if (tok !== swapTok) return;
      guideText.textContent = text;
      bubble.classList.remove('swap');
    }, 150);
  }

  function guideLine() {
    if (hoverSay) return hoverSay;
    const statusEl = $('status');
    const status = statusEl ? statusEl.textContent : '';
    if (isRunning()) return '만드는 중이야! 이 탭을 켜 둔 채로 기다려 줘 🐰';
    if (/변환하는 중/.test(status)) return '영상 읽는 중이야… 잠깐만 기다려 줘!';
    const n = clipList ? clipList.children.length : 0;
    if (!n) return '영상만 올려 주면, 비율은 내가 안 잘리게 맞출게!';
    const key = activePreset();
    if (key) return PRESETS[key].say;
    const m = status.match(/(\d+)\s*편을 만들 준비/);
    if (m) return m[1] + '편 준비 완료! 위에서 프리셋 하나만 콕 누르면 설정은 끝이야.';
    return '프리셋을 하나 골라 줄래? 나머지 설정은 내가 다 맞춰 둘게.';
  }

  presetRow.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.preset');
    if (b) applyPreset(b.dataset.preset);
  });
  function presetHover(e, on) {
    const b = e.target.closest && e.target.closest('.preset');
    if (!b || b.contains(e.relatedTarget)) return;
    const p = PRESETS[b.dataset.preset];
    if (on && p && !isRunning()) { hoverSay = p.say; say(hoverSay); }
    else if (!on) { hoverSay = null; say(guideLine()); }
  }
  presetRow.addEventListener('pointerover', (e) => presetHover(e, true));
  presetRow.addEventListener('pointerout', (e) => presetHover(e, false));
  presetRow.addEventListener('focusin', (e) => presetHover(e, true));
  presetRow.addEventListener('focusout', (e) => presetHover(e, false));

  // ---------------------------------------------------------------- 3-a. 커서 자리를 따라 색이 번지는 스포트라이트
  function trackSpot(el) {
    if (!el || el.dataset.spotOn) return;
    el.dataset.spotOn = '1';
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(2) + '%');
      el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(2) + '%');
    }, { passive: true });
  }
  function trackSpots(root) {
    const list = (root || document).querySelectorAll('.preset, .seg button, .drop, .clip-card');
    for (let i = 0; i < list.length; i++) trackSpot(list[i]);
  }
  trackSpots();
  if (clipList) new MutationObserver(() => trackSpots(clipList)).observe(clipList, { childList: true });

  // ---------------------------------------------------------------- 3-b. 미리보기 스포트라이트 + '보정 전' 비교
  const fx = $('stageFx');
  const cmpWrap = $('cmpWrap');
  const cmpCv = $('cmpCanvas');
  const cmpCtx = cmpCv ? cmpCv.getContext('2d') : null;
  const origCv = document.createElement('canvas');
  let mx = 0.5, my = 0.5, frame = 0;

  function hideCmp() { if (cmpWrap) cmpWrap.hidden = true; }
  function scheduleCompare() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; drawCompare(); });
  }

  function drawCompare() {
    if (!cmpWrap || !cmpCtx || !fx) return;
    if (isRunning()) { hideCmp(); return; }
    const clips = (typeof state !== 'undefined' && state && state.clips) || [];
    if (!clips.length) { hideCmp(); return; }
    let sel = null;
    try { sel = currentSelection(); } catch (err) { sel = null; }
    if (!sel || !sel.clip || !sel.out || !sel.clip.thumb || !sel.clip.thumb.videoWidth) { hideCmp(); return; }

    const W = screenCv.width, H = screenCv.height;
    if (!W || !H) { hideCmp(); return; }
    if (origCv.width !== W || origCv.height !== H) { origCv.width = W; origCv.height = H; }
    const g = origCv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    if ('filter' in g) g.filter = 'none';
    const vertSrc = sel.clip.h > sel.clip.w;
    const mode = sel.out.kind === 'crop' ? { cropX: sel.clip.cropX }
      : (vertSrc && sel.out.fmt === 'h') ? 'contain' : 'cover';
    try { drawVideo(g, sel.clip.thumb, W, H, mode); } catch (err) { hideCmp(); return; }

    const rect = screenCv.getBoundingClientRect();
    const shownW = rect.width || W;
    const side = Math.max(1, Math.min(W, H, 148 * (W / shownW)));
    const cx = mx * W, cy = my * H;
    const sx = clamp(cx - side / 2, 0, Math.max(0, W - side));
    const sy = clamp(cy - side / 2, 0, Math.max(0, H - side));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(148 * dpr);
    if (cmpCv.width !== px || cmpCv.height !== px) { cmpCv.width = px; cmpCv.height = px; }
    cmpCtx.setTransform(1, 0, 0, 1, 0, 0);
    cmpCtx.clearRect(0, 0, px, px);
    cmpCtx.drawImage(origCv, sx, sy, side, side, 0, 0, px, px);
    cmpWrap.hidden = false;
  }

  function onStageMove(e) {
    if (e.pointerType === 'touch') return;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = e.clientX - r.left, y = e.clientY - r.top;
    stage.style.setProperty('--mx', (x / r.width * 100).toFixed(2) + '%');
    stage.style.setProperty('--my', (y / r.height * 100).toFixed(2) + '%');
    mx = clamp(x / r.width, 0, 1);
    my = clamp(y / r.height, 0, 1);
    if (cmpWrap) {
      const hw = Math.min(82, r.width / 2), hh = Math.min(82, r.height / 2);
      cmpWrap.style.left = clamp(x, hw, r.width - hw).toFixed(1) + 'px';
      cmpWrap.style.top = clamp(y, hh, r.height - hh).toFixed(1) + 'px';
    }
    scheduleCompare();
  }
  stage.addEventListener('pointermove', onStageMove, { passive: true });
  stage.addEventListener('pointerenter', onStageMove, { passive: true });
  stage.addEventListener('pointerleave', hideCmp);

  // ---------------------------------------------------------------- 상태 따라가기 (0.4초마다 화면만 읽음)
  markPresets();
  say(guideLine());
  setInterval(() => {
    markPresets();
    say(guideLine());
    if (isRunning()) hideCmp();
  }, 420);
})();
