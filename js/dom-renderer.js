// ==================== DOM 实时预览渲染组件 ====================
// 使用 React.createElement，无需 JSX/Babel

const h = React.createElement;

// ---- CharMask: 逐字 clip-path 遮罩 ----
function CharMask({ text, progress, fontSize, letterSpacing, fontFamily, fontWeight,
                      colorBefore, colorAfter, strokeBefore, strokeAfter, strokeWidth }) {
    const pct = progress;
    const sw = strokeWidth || Math.max(1, Math.round(fontSize * 0.12));
    const safePad = sw;
    const shadowB = genStroke(strokeBefore, sw);
    const shadowA = genStroke(strokeAfter, sw);
    const textBase = {
        fontFamily, fontWeight,
        fontSize: `${fontSize}px`,
        lineHeight: '1.2', whiteSpace: 'pre',
        padding: `${safePad}px`,
        display: 'inline-block',
        fontKerning: 'none',
        fontVariantLigatures: 'none',
        fontOpticalSizing: 'none',
    };
    const rightClip = 100 - pct;
    return h('span', { style: { position: 'relative', display: 'inline-block', verticalAlign: 'bottom', margin: `-${safePad}px` } },
        h('span', { style: { ...textBase, color: colorBefore, textShadow: shadowB } }, text),
        h('span', { style: { ...textBase, color: colorAfter, textShadow: shadowA, position: 'absolute', top: 0, left: 0, clipPath: `inset(-50% ${rightClip}% -50% -${safePad}px)` } }, text)
    );
}

// ---- RubyMask: 注音逐字 clip-path ----
function RubyMask({ text, progress, fontSize, letterSpacing, fontFamily, fontWeight,
                      colorBefore, colorAfter, strokeBefore, strokeAfter, strokeWidth }) {
    if (!text) return null;
    const pct = progress;
    const sw = strokeWidth || Math.max(0.5, fontSize * 0.1);
    const safePad = Math.max(1, sw);
    const shadowB = genStroke(strokeBefore, sw);
    const shadowA = genStroke(strokeAfter, sw);
    const textBase = {
        fontFamily, fontWeight: fontWeight || 'normal',
        fontSize: `${fontSize}px`, letterSpacing: `${letterSpacing}px`,
        lineHeight: '1.1', whiteSpace: 'pre',
        padding: `${safePad}px`, display: 'inline-block',
        backfaceVisibility: 'hidden',  // 强制灰度抗锯齿，消除小字号 ClearType 彩边
        fontKerning: 'none',
        fontVariantLigatures: 'none',
        fontOpticalSizing: 'none',
    };
    const rightClip = 100 - pct;
    return h('span', { style: { position: 'relative', display: 'inline-block', verticalAlign: 'bottom', marginTop: -safePad, marginBottom: -safePad, marginLeft: -safePad, marginRight: -(safePad + (letterSpacing || 0)) } },
        h('span', { style: { ...textBase, color: colorBefore, textShadow: shadowB } }, text),
        h('span', { style: { ...textBase, color: colorAfter, textShadow: shadowA, position: 'absolute', top: 0, left: 0, clipPath: `inset(-50% ${rightClip}% -50% -${safePad}px)` } }, text)
    );
}

// ---- LyricLine: 歌词行（连词组注音居中） ----
function LyricLine({ line, config, currentTime }) {
    const chars = line?.chars;
    if (!chars || chars.length === 0) return null;

    // 淡入淡出透明度
    let fadeOpacity = 1;
    if (config.fadeEnabled && line) {
        const dur = (config.fadeDurationMs || 666) / 1000;
        const entryT = line.entryTime ?? (line.startTime - 2);
        const exitT = line.endTime + 2;
        const shouldFadeIn = config.fadeParagraphOnly ? (line.isFirstInParagraph ?? false) : true;
        const shouldFadeOut = config.fadeParagraphOnly ? (line.isLastInParagraph ?? false) : true;
        let opacityFromFade = 1;
        if (shouldFadeIn && currentTime < entryT + dur) opacityFromFade = Math.max(0, (currentTime - entryT) / dur);
        if (shouldFadeOut && currentTime > exitT - dur) {
            const fadeOut = Math.max(0, (exitT - currentTime) / dur);
            opacityFromFade = Math.min(opacityFromFade, fadeOut);
        }
        fadeOpacity = Math.max(0, Math.min(1, opacityFromFade));
    }

    // 分组（按 rubySpan）
    const groups = [];
    for (let i = 0; i < chars.length; ) {
        const c = chars[i];
        const span = c.rubySpan || 0;
        if (span > 1 && c.ruby) {
            groups.push({ ruby: c.ruby, rubyChars: c.rubyChars || null, chars: chars.slice(i, i + span), key: i });
            i += span;
        } else {
            groups.push({ ruby: c.ruby || null, rubyChars: c.rubyChars || null, chars: [c], key: i });
            i += 1;
        }
    }

    // 注音假名进度（有时序数据时逐假名独立走字）
    const getRubyCharProgress = (g, idx) => {
        const rChars = g.rubyChars;
        if (!rChars || rChars.length === 0 || idx >= rChars.length) return null;
        const kanjiStart = g.chars[0].startTime;
        const kanjiEnd = g.chars[g.chars.length - 1].endTime;
        const rc = rChars[idx];
        const charStart = kanjiStart + (rc.offsetSec || 0);
        const charEnd = (idx < rChars.length - 1)
            ? kanjiStart + (rChars[idx + 1].offsetSec || kanjiEnd - kanjiStart)
            : kanjiEnd;
        if (currentTime < charStart) return 0;
        if (currentTime >= charEnd) return 100;
        const rawPct = ((currentTime - charStart) / (charEnd - charStart)) * 100;
        const pad = config.rubyStrokeWidth || Math.max(1, Math.round(config.rubySize * 0.1));
        const fs = config.rubySize;
        const fwRuby = config.rubyBold ? 'bold ' : '';
        const fontStr = `${fwRuby}${fs}px ${config.fontFamily}`;
        const ink = measureGlyphInk(rc.char, fontStr);
        const domW = measureTotalWidth(rc.char, fs, config.fontFamily, rc.char.length > 1 ? (config.rubyLetterSpacing || 0) : 0, fwRuby.trim() || 'normal');
        const emW = Math.max(ink.emWidth || fs, domW);
        const total = emW + 2 * pad;
        const gLeft = ink.left || 0, gRight = ink.right || emW;
        const pixelL = -gLeft, pixelR = gRight;
        const offsetL = pad + pixelL, offsetR = pad + pixelR;
        const strokeL = offsetL - pad - 1, strokeR = offsetR + pad + 1;
        const startFrac = (strokeL / total) * 100, endFrac = (strokeR / total) * 100;
        return startFrac + (rawPct / 100) * (endFrac - startFrac);
    };

    // 整组注音进度
    const getRubyProgress = (g) => {
        if (!g.ruby || g.chars.length === 0) return 0;
        const t0 = g.chars[0].startTime, t1 = g.chars[g.chars.length - 1].endTime;
        if (currentTime < t0) return 0;
        if (currentTime >= t1) return 100;
        const rawPct = ((currentTime - t0) / (t1 - t0)) * 100;
        const pad = config.rubyStrokeWidth || Math.max(1, Math.round(config.rubySize * 0.1));
        const fs = config.rubySize, fwRuby = config.rubyBold ? 'bold ' : '';
        const fontStr = `${fwRuby}${fs}px ${config.fontFamily}`;
        const ink = measureGlyphInk(g.ruby, fontStr);
        const domW = measureTotalWidth(g.ruby, fs, config.fontFamily, 0, fwRuby.trim() || 'normal');
        const emW = Math.max(ink.emWidth || fs, domW);
        const total = emW + 2 * pad;
        const gL = ink.left || 0, gR = ink.right || emW;
        const pL = -gL, pR = gR;
        const oL = pad + pL, oR = pad + pR;
        const sL = oL - pad - 1, sR = oR + pad + 1;
        const sF = (sL / total) * 100, eF = (sR / total) * 100;
        return sF + (rawPct / 100) * (eF - sF);
    };

    // 主字墨迹走字
    const getProgress = (c) => {
        const rawPct = currentTime < c.startTime ? 0 : currentTime >= c.endTime ? 100 : ((currentTime - c.startTime) / (c.endTime - c.startTime)) * 100;
        const isRuby = !!c.ruby;
        const pad = isRuby ? (config.rubyStrokeWidth || Math.max(1, Math.round(config.rubySize * 0.1))) : (config.strokeWidth || Math.round(config.fontSize * 0.12));
        const fs = isRuby ? config.rubySize : config.fontSize;
        const fwIsBold = isRuby ? config.rubyBold : config.fontBold;
        const fw = fwIsBold ? 'bold ' : '';
        const fontStr = `${fw}${fs}px ${config.fontFamily}`;
        const ink = measureGlyphInk(c.text, fontStr);
        const domW = measureTotalWidth(c.text, fs, config.fontFamily, 0, fw.trim() || 'normal');
        const emW = Math.max(ink.emWidth || fs, domW);
        const total = emW + 2 * pad;
        const gLeft = ink.left || 0, gRight = ink.right || emW;
        const pixelL = -gLeft, pixelR = gRight;
        const offsetL = pad + pixelL, offsetR = pad + pixelR;
        const strokeL = offsetL - pad - 1, strokeR = offsetR + pad + 1;
        const startFrac = (strokeL / total) * 100, endFrac = (strokeR / total) * 100;
        return startFrac + (rawPct / 100) * (endFrac - startFrac);
    };

    // 多音节分组走字
    const getGroupedCharProgress = (c, g) => {
        const rChars = g.rubyChars;
        const N = rChars.length, K = g.chars.length;
        const groupStart = g.chars[0].startTime, groupEnd = g.chars[K - 1].endTime;
        const groupSpan = groupEnd - groupStart;
        let segIdx = 0;
        for (let si = 0; si < N; si++) {
            const segS = groupStart + (rChars[si].offsetSec || 0);
            const segE = (si < N - 1) ? groupStart + (rChars[si + 1].offsetSec || (groupSpan * (si + 1) / N)) : groupEnd;
            if (currentTime >= segS && currentTime < segE) { segIdx = si; break; }
            if (si === N - 1 && currentTime >= segE) { segIdx = N - 1; break; }
        }
        const segStartAbs = groupStart + (rChars[segIdx].offsetSec || 0);
        const segEndAbs = (segIdx < N - 1) ? groupStart + (rChars[segIdx + 1].offsetSec || (groupSpan * (segIdx + 1) / N)) : groupEnd;
        let segProgress;
        if (currentTime < groupStart) segProgress = 0;
        else if (currentTime >= groupEnd) segProgress = 1;
        else segProgress = Math.max(0, Math.min(1, (currentTime - segStartAbs) / (segEndAbs - segStartAbs)));
        const G = ((segIdx + segProgress) / N) * K * 100;
        const ki = g.chars.indexOf(c);
        const rawPct = Math.max(0, Math.min(100, G - ki * 100));
        const isRuby = !!c.ruby;
        const pad = isRuby ? (config.rubyStrokeWidth || Math.max(1, Math.round(config.rubySize * 0.1))) : (config.strokeWidth || Math.round(config.fontSize * 0.12));
        const fs = isRuby ? config.rubySize : config.fontSize;
        const fwIsBold = isRuby ? config.rubyBold : config.fontBold;
        const fw = fwIsBold ? 'bold ' : '';
        const fontStr = `${fw}${fs}px ${config.fontFamily}`;
        const ink = measureGlyphInk(c.text, fontStr);
        const domW = measureTotalWidth(c.text, fs, config.fontFamily, 0, fw.trim() || 'normal');
        const emW = Math.max(ink.emWidth || fs, domW);
        const total = emW + 2 * pad;
        const gLeft = ink.left || 0, gRight = ink.right || emW;
        const pixelL = -gLeft, pixelR = gRight;
        const offsetL = pad + pixelL, offsetR = pad + pixelR;
        const strokeL = offsetL - pad - 1, strokeR = offsetR + pad + 1;
        const startFrac = (strokeL / total) * 100, endFrac = (strokeR / total) * 100;
        return startFrac + (rawPct / 100) * (endFrac - startFrac);
    };

    // 指示灯
    const showIndicator = config.indicatorEnabled && line && line.isFirstInParagraph && line.lineInParagraph === 0;
    const dotOpacities = [1, 1, 1, 1];
    if (showIndicator) {
        const dur = config.indicatorDuration || 4;
        const qDur = dur / 4;
        const fadeR = Math.max(0, Math.min(1, config.indicatorFadeRatio || 0));
        for (let d = 0; d < 4; d++) {
            const disappearAt = line.startTime - dur + (d + 1) * qDur;
            const fadeStart = disappearAt - qDur;
            const fadeDuration = qDur * fadeR;
            const fadeEnd = fadeStart + fadeDuration;
            if (currentTime >= fadeEnd) dotOpacities[d] = 0;
            else if (currentTime > fadeStart && fadeDuration > 0) dotOpacities[d] = (fadeEnd - currentTime) / fadeDuration;
        }
    }

    const children = [];

    // 指示灯
    if (showIndicator) {
        const dots = [];
        [...dotOpacities].reverse().forEach((op, di) => {
            const r = config.indicatorSize / 2;
            const sw = config.indicatorStrokeWidth;
            dots.push(h('svg', { key: di, width: config.indicatorSize, height: config.indicatorSize, style: { opacity: op, transition: 'none' } },
                h('circle', { cx: r, cy: r, r: r - sw / 2, fill: config.indicatorFillColor, stroke: config.indicatorStrokeColor, strokeWidth: sw })
            ));
        });
        children.push(h('div', { key: 'indicator', style: { position: 'absolute', left: `${config.indicatorOffsetX}px`, bottom: `calc(100% + ${config.rubySize + config.rubyOffset + config.indicatorOffsetY}px)`, display: 'flex', gap: `${config.indicatorSpacing}px`, alignItems: 'flex-end', height: `${config.indicatorSize}px` } }, ...dots));
    }

    // 歌词组
    groups.forEach((g, gi) => {
        const groupChildren = [];

        // 注音
        if (g.ruby) {
            const rubyEls = [];
            if (g.rubyChars && g.rubyChars.length > 1) {
                g.rubyChars.forEach((rc, ri) => {
                    rubyEls.push(h(RubyMask, { key: ri, text: rc.char, progress: getRubyCharProgress(g, ri), fontSize: config.rubySize, letterSpacing: rc.char.length > 1 ? config.rubyLetterSpacing : 0, fontFamily: config.fontFamily, fontWeight: config.rubyBold ? 'bold' : 'normal', colorBefore: config.colorBefore, colorAfter: config.colorAfter, strokeBefore: config.strokeColorBefore, strokeAfter: config.strokeColorAfter, strokeWidth: config.rubyStrokeWidth }));
                });
            } else {
                rubyEls.push(h(RubyMask, { key: 'r', text: g.ruby, progress: getRubyProgress(g), fontSize: config.rubySize, letterSpacing: config.rubyLetterSpacing, fontFamily: config.fontFamily, fontWeight: config.rubyBold ? 'bold' : 'normal', colorBefore: config.colorBefore, colorAfter: config.colorAfter, strokeBefore: config.strokeColorBefore, strokeAfter: config.strokeColorAfter, strokeWidth: config.rubyStrokeWidth }));
            }
            groupChildren.push(h('div', { key: 'ruby', className: 'flex justify-center', style: { position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', paddingBottom: `${config.rubyOffset}px`, whiteSpace: 'nowrap' } },
                h('span', { style: { display: 'inline-flex', gap: `${config.rubyLetterSpacing}px` } }, ...rubyEls)
            ));
        }

        // 主字
        const charEls = g.chars.map((c, ci) => {
            const progress = (g.rubyChars && g.rubyChars.length > 1) ? getGroupedCharProgress(c, g) : getProgress(c);
            return h(CharMask, { key: ci, text: c.text, progress, fontSize: config.fontSize, letterSpacing: 0, fontFamily: config.fontFamily, fontWeight: config.fontBold ? 'bold' : 'normal', colorBefore: config.colorBefore, colorAfter: config.colorAfter, strokeBefore: config.strokeColorBefore, strokeAfter: config.strokeColorAfter, strokeWidth: config.strokeWidth });
        });
        groupChildren.push(h('div', { key: 'chars', className: 'flex items-end', style: { gap: `${config.letterSpacing}px` } }, ...charEls));

        children.push(h('div', { key: gi, className: 'flex flex-col items-center', style: { position: 'relative' } }, ...groupChildren));
    });

    return h('div', { className: 'flex items-end', style: { gap: `${config.letterSpacing}px`, opacity: fadeOpacity, position: 'relative' } }, ...children);
}
