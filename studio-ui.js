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
    card: {
      set: { card: true, theme: 'classic', opening: 'none', ending: 'none', watermark: true },
      say: '카드 쇼츠로 담을게! 프로필·제목·자막이 카드 안에 들어가고, 글자는 미리보기에서 바로 고칠 수 있어.',
    },
    shorts: {
      set: { card: false, theme: 'classic', opening: 'intro4s', ending: 'shorts', watermark: true },
      say: '세로 쇼츠는 크림 카드로 맞췄어! 세로 영상은 위아래 안 잘리게 1080×1920으로 담을게.',
    },
    vlog: {
      set: { card: false, theme: 'classic', opening: 'official', ending: 'none', watermark: true },
      say: '가로 브이로그는 공식 오프닝으로 천천히 열고, 끝은 담백하게 끊을게.',
    },
    caption: {
      set: { card: false, theme: 'classic', opening: 'none', ending: 'none', watermark: false },
      say: '오프닝·엔딩·로고는 빼고, 영상마다 적어 준 제목과 자막만 얹을게!',
    },
    autumn: {
      set: { card: false, theme: 'autumn', opening: 'intro4s', ending: 'shorts', watermark: true },
      say: '가을 테마! 크림 종이에 낙엽이 쏟아지며 넘어가. 따뜻한 결로 맞춰 볼까?',
    },
  };
  const PRESET_KEYS = Object.keys(PRESETS);

  function activePreset() {
    const theme = segValue('themeSeg'), opening = segValue('openingSeg'), ending = segValue('endingSeg');
    const wm = $('watermark'), cardOn = !!state.card;
    for (let i = 0; i < PRESET_KEYS.length; i++) {
      const k = PRESET_KEYS[i], s = PRESETS[k].set;
      if (cardOn !== !!s.card) continue;
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
    state.card = !!p.set.card;
    syncCardUI();
    refresh();
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
    if (state.card) {
      let sel = null;
      try { sel = currentSelection(); } catch (err) { sel = null; }
      if (sel && sel.out && sel.out.fmt !== 'v') return '카드는 세로 쇼츠에만 들어가. 이 영상은 가로라서 꽉 찬 화면으로 만들게.';
    }
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

  // ---------------------------------------------------------------- 카드 쇼츠 설정 (크림 카드 · 네모 박스 · 영상 크기 · 프로필)
  const cardSeg = $('cardSeg'), cardOpts = $('cardOpts'), cardFrameEl = $('cardFrame');
  const cardScaleEl = $('cardScale'), cardScaleVal = $('cardScaleVal');
  const iconSeg = $('iconSeg'), iconPick = $('iconPick'), iconFile = $('iconFile');

  function syncCardUI() {
    const on = !!state.card;
    if (cardSeg) {
      cardSeg.querySelectorAll('button').forEach((b) => {
        const isOn = (b.dataset.v === 'on') === on;
        b.classList.toggle('on', isOn);
        b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      });
    }
    if (cardOpts) cardOpts.hidden = !on;
    if (cardFrameEl) cardFrameEl.checked = !!state.cardFrame;
    if (cardScaleEl) cardScaleEl.value = String(Math.round(state.cardScale * 100));
    if (cardScaleVal) cardScaleVal.textContent = Math.round(state.cardScale * 100) + '%';
    if (iconSeg) {
      iconSeg.querySelectorAll('button').forEach((b) => {
        const isOn = b.dataset.v === state.cardIcon;
        b.classList.toggle('on', isOn);
        b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      });
    }
  }

  function setCard(on) {
    if (isRunning()) return;
    state.card = !!on;
    syncCardUI();
    refresh();
    renderEditOverlay();
    markPresets();
    say(guideLine());
  }

  if (cardSeg) cardSeg.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (b) setCard(b.dataset.v === 'on');
  });
  if (cardFrameEl) cardFrameEl.addEventListener('change', () => {
    if (isRunning()) return;
    state.cardFrame = cardFrameEl.checked;
    refresh();
  });
  if (cardScaleEl) cardScaleEl.addEventListener('input', () => {
    if (isRunning()) return;
    state.cardScale = clamp(+cardScaleEl.value / 100, 0.42, 0.86);
    if (cardScaleVal) cardScaleVal.textContent = cardScaleEl.value + '%';
    refresh();
    renderEditOverlay();
  });
  if (iconSeg) iconSeg.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (!b || isRunning()) return;
    state.cardIcon = b.dataset.v;
    syncCardUI();
    refresh();
    renderEditOverlay();
    say(b.dataset.v === 'none' ? '프로필 동그라미를 뺐어. 제목이 위로 올라와.' : '동그란 토순이 프로필로 돌아왔어!');
  });
  if (iconPick && iconFile) {
    iconPick.addEventListener('click', () => { if (!isRunning()) iconFile.click(); });
    iconFile.addEventListener('change', () => {
      const f = iconFile.files && iconFile.files[0];
      iconFile.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) { say('사진 파일(png·jpg)만 넣을 수 있어!'); return; }
      const fr = new FileReader();
      fr.onload = () => {
        state.cardIcon = String(fr.result);
        syncCardUI();
        refresh();
        renderEditOverlay();
        say('프로필 사진을 바꿨어! 카드 위에 동그랗게 들어갔어.');
      };
      fr.readAsDataURL(f);
    });
  }

  // ---------------------------------------------------------------- 미리보기에서 제목·자막 바로 고치기
  const stageEdit = $('stageEdit');
  const editEls = stageEdit ? Array.from(stageEdit.querySelectorAll('.edit-hot')) : [];
  let editing = null;

  function cardTarget() {
    if (!stageEdit || !state.card || isRunning()) return null;
    let sel = null;
    try { sel = currentSelection(); } catch (err) { sel = null; }
    if (!sel || !sel.out || sel.out.fmt !== 'v') return null;
    if (!sel.clip || !sel.clip.thumb || !sel.clip.thumb.videoWidth) return null;
    return sel;
  }

  function layoutBoxes(sel) {
    const W = screenCv.width, H = screenCv.height;
    const L = cardLayout(W, H, sel.clip, sel.out.kind);
    const r = screenCv.getBoundingClientRect();
    const k = r.width / W;
    const mk = (b) => ({
      left: ((W - b.maxW) / 2) * k,
      width: b.maxW * k,
      top: (b.y - b.px * 0.35) * k,
      height: b.px * 1.36 * k,
      px: b.px * k,
    });
    return { title: mk(L.title), caption: mk(L.caption) };
  }

  function renderEditOverlay() {
    if (!stageEdit) return;
    const sel = cardTarget();
    if (!sel) { stageEdit.hidden = true; return; }
    stageEdit.hidden = false;
    const boxes = layoutBoxes(sel);
    editEls.forEach((el) => {
      const kind = el.dataset.edit;
      const b = boxes[kind];
      if (!b) { el.hidden = true; return; }
      const text = String((kind === 'title' ? sel.clip.title : sel.clip.caption) || '').trim();
      el.hidden = false;
      el.style.left = b.left.toFixed(1) + 'px';
      el.style.top = b.top.toFixed(1) + 'px';
      el.style.width = b.width.toFixed(1) + 'px';
      el.style.height = b.height.toFixed(1) + 'px';
      el.classList.toggle('empty', !text);
      if (editing && editing.el === el) return;
      const t = el.querySelector('.edit-txt');
      if (t) {
        t.textContent = text || (kind === 'title' ? '제목을 눌러 적기' : '자막을 눌러 적기');
        t.style.fontSize = Math.max(9, Math.min(22, b.px * 0.9)).toFixed(1) + 'px';
      }
    });
  }

  function startEdit(el) {
    if (editing) return;
    const sel = cardTarget();
    if (!sel) return;
    const kind = el.dataset.edit;
    const cur = String((kind === 'title' ? sel.clip.title : sel.clip.caption) || '');
    const t = el.querySelector('.edit-txt');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'edit-input';
    input.value = cur;
    input.maxLength = kind === 'title' ? 24 : 40;
    input.setAttribute('aria-label', kind === 'title' ? '카드 제목 고치기' : '카드 자막 고치기');
    input.style.fontSize = t ? t.style.fontSize : '14px';
    if (t) t.style.display = 'none';
    el.append(input);
    editing = { kind, el, input, clip: sel.clip };
    input.focus();
    try { input.select(); } catch (e) {}
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commitEdit(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commitEdit(false); }
    });
    input.addEventListener('blur', () => { if (editing) commitEdit(true); });
  }

  function commitEdit(save) {
    if (!editing) return;
    const { kind, clip, input, el } = editing;
    const v = String(input.value || '').slice(0, kind === 'title' ? 24 : 40);
    editing = null;
    input.remove();
    const t = el.querySelector('.edit-txt');
    if (t) t.style.display = '';
    if (save) {
      if (kind === 'title') clip.title = v; else clip.caption = v;
      renderClipList();
      refresh();
      say(kind === 'title' ? '제목을 고쳤어! 카드에도 그대로 들어갔어.' : '자막을 고쳤어! 이제 내보내기에도 그대로 들어가.');
    }
    renderEditOverlay();
  }

  editEls.forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); startEdit(el); });
  });

  // ---------------------------------------------------------------- 상태 따라가기 (0.4초마다 화면만 읽음)
  markPresets();
  syncCardUI();
  say(guideLine());
  renderEditOverlay();
  setInterval(() => {
    markPresets();
    say(guideLine());
    renderEditOverlay();
    if (isRunning()) hideCmp();
  }, 420);
})();
