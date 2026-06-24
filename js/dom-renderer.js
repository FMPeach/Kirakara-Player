// ==================== DOM 实时预览渲染组件 ====================
// 使用 React.createElement，无需 JSX/Babel

const h = React.createElement;

// Chromium 需要 +0.5px 防 subpixel 渗出，Firefox 反会因此遮罩不足
const CLIP_OVERPULL = /Firefox/i.test(navigator.userAgent) ? '-0.5px' : '0.5px';

// ---- CharMask: 逐字 clip-path 遮罩（支持 N 角色垂直等分分层） ----
function CharMask({ text, progress, fontSize, letterSpacing, fontFamily, fontWeight,
    colorBefore, colorAfter, strokeBefore, strokeAfter, strokeWidth,
    roleB_colorBefore, roleB_colorAfter, roleB_strokeBefore, roleB_strokeAfter,
    roleColors, postSpacing }) {
    const pct = Math.max(0, progress);
    const sw = strokeWidth ?? Math.max(1, Math.round(fontSize * 0.12));
    const safePad = sw <= 0 ? 0 : sw;
    const rightClip = Math.min(100, Math.max(0, 100 - pct));
    const leftClip = pct <= 0 ? '100%' : `-${safePad}px`;
    // 用 marginRight 精确控制字符间距，取代 flex gap，完美支持负间距
    const marginR = -safePad + (postSpacing !== undefined ? postSpacing : 0);

    // 统一为 roleColors 数组（兼容旧 roleB_* props）
    let allRC = roleColors;
    if (!allRC || allRC.length === 0) {
        const p = { colorBefore, colorAfter, strokeColorBefore: strokeBefore, strokeColorAfter: strokeAfter };
        const s = (roleB_colorBefore || roleB_colorAfter) ? { colorBefore: roleB_colorBefore, colorAfter: roleB_colorAfter, strokeColorBefore: roleB_strokeBefore, strokeColorAfter: roleB_strokeAfter } : null;
        allRC = s ? [p, s] : [p];
    }
    const N = allRC.length;

    const textBase = { fontFamily, fontWeight, fontSize: `${fontSize}px`, lineHeight: '1.2', whiteSpace: 'pre', padding: `${safePad}px`, display: 'inline-block', fontKerning: 'none', fontVariantLigatures: 'none', fontOpticalSizing: 'none' };

    if (N >= 2) {
        const seamFadePx = 2;
        const lh = 1.2;
        // 整个 DOM 元素的高：行高 + 上下 padding 防切断
        const totalH = fontSize * lh + safePad * 2;
        // 【核心修正】计算物理 1.0em 字框在 DOM 中的绝对顶部起点 (减去 line-height 均分的留白)
        const emTopPx = safePad + fontSize * (lh - 1.0) / 2;
        const cjTopPct = (emTopPx / totalH) * 100;
        const cjBotPct = ((emTopPx + fontSize) / totalH) * 100;
        const cjRange = cjBotPct - cjTopPct;
        const seamFadePct = (seamFadePx / totalH) * 100;

        const children = [h('span', { style: { ...textBase, color: 'transparent' } }, text)];
        for (let i = 0; i < N; i++) {
            const rc = allRC[i];
            const sB = genStroke(rc.strokeColorBefore, sw), sA = genStroke(rc.strokeColorAfter, sw);
            // 对齐 Canvas 渐变中心偏移: Canvas 位置 p 对应字框 0.12+p
            const roleTop = cjTopPct + cjRange * (0.04 + i / N);
            const roleBot = cjTopPct + cjRange * (0.04 + (i + 1) / N);
            
            let roleMask;
            if (i === 0) {
                // 顶部层：向上无限延伸黑底保护超粗描边，向下做 2px 羽化
                roleMask = `linear-gradient(to bottom, black 0%, black ${roleBot}%, transparent ${roleBot + seamFadePct}%, transparent 100%)`;
            } else if (i === N - 1) {
                // 底部层：向上做 2px 羽化，向下无限延伸黑底保护超粗描边
                roleMask = `linear-gradient(to bottom, transparent 0%, transparent ${roleTop - seamFadePct}%, black ${roleTop}%, black 100%)`;
            } else {
                // 中间层：上下均做 2px 羽化
                roleMask = `linear-gradient(to bottom, transparent 0%, transparent ${roleTop - seamFadePct}%, black ${roleTop}%, black ${roleBot}%, transparent ${roleBot + seamFadePct}%, transparent 100%)`;
            }

            children.push(h('span', { style: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, WebkitMaskImage: roleMask, maskImage: roleMask } },
                h('span', { style: { ...textBase, color: rc.colorBefore, textShadow: sB, position: 'absolute', top: 0, left: 0 } }, text),
                h('span', { style: { ...textBase, color: rc.colorAfter, textShadow: sA, position: 'absolute', top: 0, left: 0, clipPath: `inset(-50% calc(${rightClip}% + ${CLIP_OVERPULL}) -50% ${leftClip})` } }, text)));
        }
        return h('span', { style: { position: 'relative', display: 'inline-block', verticalAlign: 'bottom', margin: `-${safePad}px`, marginRight: marginR } }, ...children);
    }

    const shadowB = genStroke(strokeBefore, sw), shadowA = genStroke(strokeAfter, sw);
    return h('span', { style: { position: 'relative', display: 'inline-block', verticalAlign: 'bottom', margin: `-${safePad}px`, marginRight: marginR } },
        h('span', { style: { ...textBase, color: colorBefore, textShadow: shadowB } }, text),
        h('span', { style: { ...textBase, color: colorAfter, textShadow: shadowA, position: 'absolute', top: 0, left: 0, clipPath: `inset(-50% calc(${rightClip}% + ${CLIP_OVERPULL}) -50% ${leftClip})` } }, text));
}

// ---- RubyMask: 注音逐字 clip-path（支持 N 角色垂直等分分层） ----
function RubyMask({ text, progress, fontSize, letterSpacing, fontFamily, fontWeight,
    colorBefore, colorAfter, strokeBefore, strokeAfter, strokeWidth,
    roleB_colorBefore, roleB_colorAfter, roleB_strokeBefore, roleB_strokeAfter,
    roleColors, postSpacing }) {
    if (!text) return null;
    const pct = Math.max(0, progress);
    const sw = strokeWidth ?? Math.max(0.5, fontSize * 0.1);
    const safePad = sw <= 0 ? 0 : Math.max(1, sw);
    const textBase = { 
        fontFamily, fontWeight: fontWeight || 'normal',
        fontSize: `${fontSize}px`, letterSpacing: `${letterSpacing}px`,
        lineHeight: '1.1', whiteSpace: 'pre',
        padding: `${safePad}px`, display: 'inline-block',
        backfaceVisibility: 'hidden',
        fontKerning: 'none', fontVariantLigatures: 'none', fontOpticalSizing: 'none',
    };
    const rightClip = Math.min(100, Math.max(0, 100 - pct));
    const leftClip = pct <= 0 ? '100%' : `-${safePad}px`;

    let allRC = roleColors;
    if (!allRC || allRC.length === 0) {
        const p = { colorBefore, colorAfter, strokeColorBefore: strokeBefore, strokeColorAfter: strokeAfter };
        const s = (roleB_colorBefore || roleB_colorAfter) ? { colorBefore: roleB_colorBefore, colorAfter: roleB_colorAfter, strokeColorBefore: roleB_strokeBefore, strokeColorAfter: roleB_strokeAfter } : null;
        allRC = s ? [p, s] : [p];
    }
    const N = allRC.length;
    // 抵消 CSS letterSpacing 末尾多余空间，再加入 postSpacing 精确控距
    const marginR = -safePad - (letterSpacing !== undefined ? letterSpacing : 0) + (postSpacing !== undefined ? postSpacing : 0);
    const marginStyle = { marginTop: -safePad, marginBottom: -safePad, marginLeft: -safePad, marginRight: marginR };

    if (N >= 2) {
        const seamFadePx = 2;
        const lh = 1.1;
        const totalH = fontSize * lh + safePad * 2;
        const emTopPx = safePad + fontSize * (lh - 1.0) / 2;
        const cjTopPct = (emTopPx / totalH) * 100;
        const cjBotPct = ((emTopPx + fontSize) / totalH) * 100;
        const cjRange = cjBotPct - cjTopPct;
        const seamFadePct = (seamFadePx / totalH) * 100;

        const children = [h('span', { style: { ...textBase, color: 'transparent' } }, text)];
        for (let i = 0; i < N; i++) {
            const rc = allRC[i];
            const sB = genStroke(rc.strokeColorBefore, sw), sA = genStroke(rc.strokeColorAfter, sw);
            const roleTop = cjTopPct + cjRange * (0.04 + i / N);
            const roleBot = cjTopPct + cjRange * (0.04 + (i + 1) / N);
            
            let roleMask;
            if (i === 0) {
                // 顶部层保护罩
                roleMask = `linear-gradient(to bottom, black 0%, black ${roleBot}%, transparent ${roleBot + seamFadePct}%, transparent 100%)`;
            } else if (i === N - 1) {
                // 底部层保护罩
                roleMask = `linear-gradient(to bottom, transparent 0%, transparent ${roleTop - seamFadePct}%, black ${roleTop}%, black 100%)`;
            } else {
                // 中间羽化过渡
                roleMask = `linear-gradient(to bottom, transparent 0%, transparent ${roleTop - seamFadePct}%, black ${roleTop}%, black ${roleBot}%, transparent ${roleBot + seamFadePct}%, transparent 100%)`;
            }

            children.push(h('span', { style: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, WebkitMaskImage: roleMask, maskImage: roleMask } },
                h('span', { style: { ...textBase, color: rc.colorBefore, textShadow: sB, position: 'absolute', top: 0, left: 0 } }, text),
                h('span', { style: { ...textBase, color: rc.colorAfter, textShadow: sA, position: 'absolute', top: 0, left: 0, clipPath: `inset(-50% calc(${rightClip}% + ${CLIP_OVERPULL}) -50% ${leftClip})` } }, text)));
        }
        return h('span', { style: { position: 'relative', display: 'inline-block', verticalAlign: 'bottom', ...marginStyle } }, ...children);
    }

    const shadowB = genStroke(strokeBefore, sw), shadowA = genStroke(strokeAfter, sw);
    return h('span', { style: { position: 'relative', display: 'inline-block', verticalAlign: 'bottom', ...marginStyle } },
        h('span', { style: { ...textBase, color: colorBefore, textShadow: shadowB } }, text),
        h('span', { style: { ...textBase, color: colorAfter, textShadow: shadowA, position: 'absolute', top: 0, left: 0, clipPath: `inset(-50% calc(${rightClip}% + ${CLIP_OVERPULL}) -50% ${leftClip})` } }, text));
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

    // 分组（按 rubySpan，注音1/2 共用跨字）
    const groups = [];
    for (let i = 0; i < chars.length;) {
        const c = chars[i];
        const span = c.rubySpan || 0;
        if (span > 1 && (c.ruby || c.ruby2)) {
            groups.push({ ruby: c.ruby || null, rubyChars: c.rubyChars || null, ruby2: c.ruby2 || null, ruby2Chars: c.ruby2Chars || null, chars: chars.slice(i, i + span), key: i });
            i += span;
        } else {
            groups.push({ ruby: c.ruby || null, rubyChars: c.rubyChars || null, ruby2: c.ruby2 || null, ruby2Chars: c.ruby2Chars || null, chars: [c], key: i });
            i += 1;
        }
    }

    // 注音避让布局计算 (Isolate + Avoidance)
    const { metrics: rubyMetrics, extraGaps: rubyExtraGaps } = computeRubyLayout(groups, config);
    const ls = config.letterSpacing;

    // 注音假名进度（有时序数据时逐假名独立走字）
    const getRubyCharProgress = (g, idx) => {
        const rChars = g.rubyChars;
        if (!rChars || rChars.length === 0 || idx >= rChars.length) return null;
        const kanjiStart = g.chars[0].startTime;
        const kanjiEnd = g.chars[g.chars.length - 1].endTime;
        const rc = rChars[idx];
        const charStart = kanjiStart + (rc.offsetSec || 0);
        const charEnd = (idx < rChars.length - 1) ? kanjiStart + (rChars[idx + 1].offsetSec || kanjiEnd - kanjiStart) : kanjiEnd;
        if (currentTime < charStart) return 0;
        if (currentTime >= charEnd) return 100;
        const rawPct = ((currentTime - charStart) / (charEnd - charStart)) * 100;
        const pad = config.rubyStrokeWidth ?? Math.max(1, Math.round(config.rubySize * 0.1));
        const fs = config.rubySize;
        const fwRuby = config.rubyBold ? 'bold ' : '';
        const fontStr = `${fwRuby}${fs}px ${config.fontFamily}`;
        const ink = measureGlyphInk(rc.char, fontStr);
        const domW = measureTotalWidth(rc.char, fs, config.fontFamily, rc.char.length > 1 ? (config.rubyLetterSpacing || 0) : 0, fwRuby.trim() || 'normal');
        const emW = Math.max(ink.emWidth || fs, domW);
        const total = emW + 2 * pad;
        // 多字符补偿：Canvas 不含 CSS letter-spacing，补上内部字距
        const lsComp = rc.char.length > 1 ? (rc.char.length - 1) * (config.rubyLetterSpacing || 0) : 0;
        const gLeft = ink.left || 0, gRight = (ink.right || 0) + lsComp || emW;
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
        const pad = config.rubyStrokeWidth ?? Math.max(1, Math.round(config.rubySize * 0.1));
        const fs = config.rubySize, fwRuby = config.rubyBold ? 'bold ' : '';
        const fontStr = `${fwRuby}${fs}px ${config.fontFamily}`;
        const ink = measureGlyphInk(g.ruby, fontStr);
        const domW = measureTotalWidth(g.ruby, fs, config.fontFamily, (config.rubyLetterSpacing || 0), fwRuby.trim() || 'normal');
        const emW = Math.max(ink.emWidth || fs, domW);
        const total = emW + 2 * pad;
        const lsComp = g.ruby.length > 1 ? (g.ruby.length - 1) * (config.rubyLetterSpacing || 0) : 0;
        const gL = ink.left || 0, gR = (ink.right || 0) + lsComp || emW;
        const pL = -gL, pR = gR;
        const oL = pad + pL, oR = pad + pR;
        const sL = oL - pad - 1, sR = oR + pad + 1;
        const sF = (sL / total) * 100, eF = (sR / total) * 100;
        return sF + (rawPct / 100) * (eF - sF);
    };

    // 注音2 逐字进度
    const getRuby2CharProgress = (g, idx) => {
        const rChars = g.ruby2Chars;
        if (!rChars || rChars.length === 0 || idx >= rChars.length) return null;
        const kanjiStart = g.chars[0].startTime;
        const kanjiEnd = g.chars[g.chars.length - 1].endTime;
        const rc = rChars[idx];
        const charStart = kanjiStart + (rc.offsetSec || 0);
        const charEnd = (idx < rChars.length - 1) ? kanjiStart + (rChars[idx + 1].offsetSec || kanjiEnd - kanjiStart) : kanjiEnd;
        if (currentTime < charStart) return 0;
        if (currentTime >= charEnd) return 100;
        const rawPct = ((currentTime - charStart) / (charEnd - charStart)) * 100;
        const pad = config.ruby2StrokeWidth ?? Math.max(1, Math.round(config.ruby2Size * 0.1));
        const fs = config.ruby2Size;
        const fwRuby = config.ruby2Bold ? 'bold ' : '';
        const fontStr = `${fwRuby}${fs}px ${config.fontFamily}`;
        const ink = measureGlyphInk(rc.char, fontStr);
        const domW = measureTotalWidth(rc.char, fs, config.fontFamily, rc.char.length > 1 ? (config.ruby2LetterSpacing || 0) : 0, fwRuby.trim() || 'normal');
        const emW = Math.max(ink.emWidth || fs, domW);
        const total = emW + 2 * pad;
        const lsComp = rc.char.length > 1 ? (rc.char.length - 1) * (config.ruby2LetterSpacing || 0) : 0;
        const gLeft = ink.left || 0, gRight = (ink.right || 0) + lsComp || emW;
        const pixelL = -gLeft, pixelR = gRight;
        const offsetL = pad + pixelL, offsetR = pad + pixelR;
        const strokeL = offsetL - pad - 1, strokeR = offsetR + pad + 1;
        const startFrac = (strokeL / total) * 100, endFrac = (strokeR / total) * 100;
        return startFrac + (rawPct / 100) * (endFrac - startFrac);
    };

    const getRuby2Progress = (g) => {
        if (!g.ruby2 || g.chars.length === 0) return 0;
        const t0 = g.chars[0].startTime, t1 = g.chars[g.chars.length - 1].endTime;
        if (currentTime < t0) return 0;
        if (currentTime >= t1) return 100;
        const rawPct = ((currentTime - t0) / (t1 - t0)) * 100;
        const pad = config.ruby2StrokeWidth ?? Math.max(1, Math.round(config.ruby2Size * 0.1));
        const fs = config.ruby2Size, fwRuby = config.ruby2Bold ? 'bold ' : '';
        const fontStr = `${fwRuby}${fs}px ${config.fontFamily}`;
        const ink = measureGlyphInk(g.ruby2, fontStr);
        const domW = measureTotalWidth(g.ruby2, fs, config.fontFamily, (config.ruby2LetterSpacing || 0), fwRuby.trim() || 'normal');
        const emW = Math.max(ink.emWidth || fs, domW);
        const total = emW + 2 * pad;
        const lsComp = g.ruby2.length > 1 ? (g.ruby2.length - 1) * (config.ruby2LetterSpacing || 0) : 0;
        const gL = ink.left || 0, gR = (ink.right || 0) + lsComp || emW;
        const pL = -gL, pR = gR;
        const oL = pad + pL, oR = pad + pR;
        const sL = oL - pad - 1, sR = oR + pad + 1;
        const sF = (sL / total) * 100, eF = (sR / total) * 100;
        return sF + (rawPct / 100) * (eF - sF);
    };

    // 主字墨迹走字
    const getProgress = (c) => {
        const rawPct = currentTime < c.startTime ? 0 : currentTime >= c.endTime ? 100 : ((currentTime - c.startTime) / (c.endTime - c.startTime)) * 100;
        const pad = config.strokeWidth ?? Math.round(config.fontSize * 0.12);
        const fs = config.fontSize;
        const fw = config.fontBold ? 'bold ' : '';
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
        const rChars = g.rubyChars || g.ruby2Chars;
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
        const pad = config.strokeWidth ?? Math.round(config.fontSize * 0.12);
        const fs = config.fontSize;
        const fw = config.fontBold ? 'bold ' : '';
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
    let lastRoleKey = null;
    groups.forEach((g, gi) => {
        // 角色外显标签：显式角色且组合变化时，为每个角色显示标签（a+b → 两张图）
        const gRoleKeys = g.chars[0]?.roles || [];
        const gExplicit = g.chars[0]?.roleExplicit;
        const gCombinedKey = gRoleKeys.join('+');
        if (gExplicit && gCombinedKey && gCombinedKey !== lastRoleKey) {
            lastRoleKey = gCombinedKey;

            // 收集可见标签
            const visibleLabels = [];
            for (const rk of gRoleKeys) {
                const gProfile = (config.characterProfiles || {})[rk] || {};
                if (!gProfile.showLabel) continue;
                const labelScale = (gProfile.labelScale || 100) / 100;
                const labelFs = Math.round(config.fontSize * labelScale);
                visibleLabels.push({ rk, profile: gProfile, labelFs, offsetY: gProfile.imageOffsetY || 0 });
            }

            if (visibleLabels.length > 0) {
                const prefix = config.roleLabelPrefix || '';
                const sep = config.roleLabelSeparator || '';
                const suffix = config.roleLabelSuffix || '';
                const labelFw = config.fontBold ? 'bold' : 'normal';
                const getRoleColor = (p) => p.displayColor || p.colorBefore || config.colorBefore;
                const getRoleStroke = (p) => p.labelStrokeColor || config.strokeColorBefore;
                const labelSw = config.strokeWidth;

                // 辅助：创建文字标签 span 数组
                const makeTextSpans = (text, color, stroke, fsVal, baseKey) => {
                    const spans = [];
                    const chars = [...text];
                    chars.forEach((ch, ci) => {
                        spans.push(h('span', {
                            key: baseKey + '-' + ci, style: {
                                fontSize: `${fsVal}px`,
                                fontFamily: config.fontFamily,
                                fontWeight: labelFw,
                                color, textShadow: genStroke(stroke, labelSw),
                                padding: `${labelSw}px`, margin: `-${labelSw}px`,
                                marginRight: ci === chars.length - 1 ? `${ls + 2 - labelSw}px` : `-${labelSw}px`,
                                display: 'inline-block', lineHeight: '1.2',
                                whiteSpace: 'pre', flexShrink: 0,
                                fontKerning: 'none', fontVariantLigatures: 'none', fontOpticalSizing: 'none',
                            }
                        }, ch));
                    });
                    return spans;
                };

                // 前缀
                if (prefix) {
                    const p = visibleLabels[0];
                    children.push(...makeTextSpans(prefix, getRoleColor(p.profile), getRoleStroke(p.profile), p.labelFs, 'label-pfx-' + gi));
                }

                for (let vi = 0; vi < visibleLabels.length; vi++) {
                    const { rk, profile: gProfile, labelFs, offsetY } = visibleLabels[vi];

                    if (gProfile.imageMode && gProfile.image) {
                        const marginL = (gProfile.labelMarginLeft || 0);
                        const marginR = (gProfile.labelMarginRight || 0) + ls + 2;
                        children.push(h('img', {
                            key: 'label-' + gi + '-' + rk, src: gProfile.image, style: {
                                height: `${labelFs}px`, width: 'auto', objectFit: 'contain',
                                marginLeft: `${marginL}px`, marginRight: `${marginR}px`,
                                position: 'relative', top: `${offsetY}px`,
                                alignSelf: 'flex-end', flexShrink: 0,
                            }
                        }));
                    } else {
                        const labelText = gProfile.displayName || rk;
                        const color = getRoleColor(gProfile);
                        const stroke = getRoleStroke(gProfile);
                        children.push(...makeTextSpans(labelText, color, stroke, labelFs, 'label-' + gi + '-' + rk));
                    }

                    // 分隔符
                    if (sep && vi < visibleLabels.length - 1) {
                        children.push(...makeTextSpans(sep, getRoleColor(gProfile), getRoleStroke(gProfile), labelFs, 'label-sep-' + gi + '-' + vi));
                    }
                }

                // 后缀
                if (suffix) {
                    const last = visibleLabels[visibleLabels.length - 1];
                    children.push(...makeTextSpans(suffix, getRoleColor(last.profile), getRoleStroke(last.profile), last.labelFs, 'label-sfx-' + gi));
                }
            }
        }

        const groupChildren = [];

        // 注音1
        if (g.ruby) {
            const rubyEls = [];
            const rRoles = g.chars[0]?.roles;
            const rProfiles = config.characterProfiles || {};
            const rRoleColors = (rRoles && rRoles.length > 0) ? rRoles.map(rn => {
                const rp = rProfiles[rn] || {};
                return { colorBefore: rp.colorBefore || config.colorBefore, colorAfter: rp.colorAfter || config.colorAfter, strokeColorBefore: rp.strokeColorBefore || config.strokeColorBefore, strokeColorAfter: rp.strokeColorAfter || config.strokeColorAfter };
            }) : [{ colorBefore: config.colorBefore, colorAfter: config.colorAfter, strokeColorBefore: config.strokeColorBefore, strokeColorAfter: config.strokeColorAfter }];
            const rcb = rRoleColors[0].colorBefore, rca = rRoleColors[0].colorAfter;
            const rsb = rRoleColors[0].strokeColorBefore, rsa = rRoleColors[0].strokeColorAfter;
            const rsw = config.rubyStrokeWidth;
            // 双角色注音
            const rls = config.rubyLetterSpacing !== undefined ? config.rubyLetterSpacing : 5;
            const rIsDual = rRoleColors.length >= 2;
            if (g.rubyChars && g.rubyChars.length > 1) {
                g.rubyChars.forEach((rc, ri) => {
                    rubyEls.push(h(RubyMask, { key: ri, text: rc.char, progress: getRubyCharProgress(g, ri), fontSize: config.rubySize, letterSpacing: rc.char.length > 1 ? rls : 0, fontFamily: config.fontFamily, fontWeight: config.rubyBold ? 'bold' : 'normal', colorBefore: rcb, colorAfter: rca, strokeBefore: rsb, strokeAfter: rsa, strokeWidth: rsw, roleColors: rIsDual ? rRoleColors : undefined, postSpacing: ri === g.rubyChars.length - 1 ? 0 : rls }));
                });
            } else {
                rubyEls.push(h(RubyMask, { key: 'r', text: g.ruby, progress: getRubyProgress(g), fontSize: config.rubySize, letterSpacing: rls, fontFamily: config.fontFamily, fontWeight: config.rubyBold ? 'bold' : 'normal', colorBefore: rcb, colorAfter: rca, strokeBefore: rsb, strokeAfter: rsa, strokeWidth: rsw, roleColors: rIsDual ? rRoleColors : undefined, postSpacing: 0 }));
            }
            groupChildren.push(h('div', { key: 'ruby', className: 'flex justify-center', style: { position: 'absolute', bottom: `calc(100% + ${config.rubyOffset}px)`, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap' } },
                h('span', { style: { display: 'inline-flex' } }, ...rubyEls)
            ));
        }

        // 主字
        const hasGroupTiming = (g.rubyChars && g.rubyChars.length > 1) || (g.ruby2Chars && g.ruby2Chars.length > 1);
        const charEls = g.chars.map((c, ci) => {
            const progress = hasGroupTiming ? getGroupedCharProgress(c, g) : getProgress(c);
            const roles = c.roles;
            const profiles = config.characterProfiles || {};
            const cRoleColors = (roles && roles.length > 0) ? roles.map(rn => {
                const rp = profiles[rn] || {};
                return { colorBefore: rp.colorBefore || config.colorBefore, colorAfter: rp.colorAfter || config.colorAfter, strokeColorBefore: rp.strokeColorBefore || config.strokeColorBefore, strokeColorAfter: rp.strokeColorAfter || config.strokeColorAfter };
            }) : [{ colorBefore: config.colorBefore, colorAfter: config.colorAfter, strokeColorBefore: config.strokeColorBefore, strokeColorAfter: config.strokeColorAfter }];
            const p1 = cRoleColors[0];
            const cb = p1.colorBefore, ca = p1.colorAfter;
            const sb = p1.strokeColorBefore, sa = p1.strokeColorAfter;
            const sw = config.strokeWidth;
            return h(CharMask, {
                key: ci, text: c.text, progress,
                fontSize: config.fontSize, letterSpacing: 0,
                fontFamily: config.fontFamily, fontWeight: config.fontBold ? 'bold' : 'normal',
                colorBefore: cb, colorAfter: ca,
                strokeBefore: sb, strokeAfter: sa,
                strokeWidth: sw,
                roleColors: cRoleColors.length >= 2 ? cRoleColors : undefined,
                postSpacing: ci === g.chars.length - 1 ? 0 : ls
            });
        });
        groupChildren.push(h('div', { key: 'chars', className: 'flex items-end' }, ...charEls));

        // 注音2
        if (g.ruby2) {
            const ruby2Els = [];
            const r2Roles = g.chars[0]?.roles;
            const r2Profiles = config.characterProfiles || {};
            const r2RoleColors = (r2Roles && r2Roles.length > 0) ? r2Roles.map(rn => {
                const rp = r2Profiles[rn] || {};
                return { colorBefore: rp.colorBefore || config.colorBefore, colorAfter: rp.colorAfter || config.colorAfter, strokeColorBefore: rp.strokeColorBefore || config.strokeColorBefore, strokeColorAfter: rp.strokeColorAfter || config.strokeColorAfter };
            }) : [{ colorBefore: config.colorBefore, colorAfter: config.colorAfter, strokeColorBefore: config.strokeColorBefore, strokeColorAfter: config.strokeColorAfter }];
            const r2cb = r2RoleColors[0].colorBefore, r2ca = r2RoleColors[0].colorAfter;
            const r2sb = r2RoleColors[0].strokeColorBefore, r2sa = r2RoleColors[0].strokeColorAfter;
            const r2sw = config.ruby2StrokeWidth;
            const r2ls = config.ruby2LetterSpacing !== undefined ? config.ruby2LetterSpacing : 4;
            const r2IsDual = r2RoleColors.length >= 2;
            if (g.ruby2Chars && g.ruby2Chars.length > 1) {
                g.ruby2Chars.forEach((rc, ri) => {
                    ruby2Els.push(h(RubyMask, { key: ri, text: rc.char, progress: getRuby2CharProgress(g, ri), fontSize: config.ruby2Size, letterSpacing: rc.char.length > 1 ? r2ls : 0, fontFamily: config.fontFamily, fontWeight: config.ruby2Bold ? 'bold' : 'normal', colorBefore: r2cb, colorAfter: r2ca, strokeBefore: r2sb, strokeAfter: r2sa, strokeWidth: r2sw, roleColors: r2IsDual ? r2RoleColors : undefined, postSpacing: ri === g.ruby2Chars.length - 1 ? 0 : r2ls }));
                });
            } else {
                ruby2Els.push(h(RubyMask, { key: 'r2', text: g.ruby2, progress: getRuby2Progress(g), fontSize: config.ruby2Size, letterSpacing: r2ls, fontFamily: config.fontFamily, fontWeight: config.ruby2Bold ? 'bold' : 'normal', colorBefore: r2cb, colorAfter: r2ca, strokeBefore: r2sb, strokeAfter: r2sa, strokeWidth: r2sw, roleColors: r2IsDual ? r2RoleColors : undefined, postSpacing: 0 }));
            }
            groupChildren.push(h('div', { key: 'ruby2', className: 'flex justify-center', style: { position: 'absolute', top: `calc(100% + ${config.ruby2Offset}px)`, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap' } },
                h('span', { style: { display: 'inline-flex' } }, ...ruby2Els)
            ));
        }

        const m = rubyMetrics[gi] || {};
        const isLastGroup = gi === groups.length - 1;
        const extraGap = isLastGroup ? 0 : (rubyExtraGaps[gi] || 0);
        const groupWrapperStyle = { position: 'relative' };
        if (m.isolatePad > 0) groupWrapperStyle.minWidth = `${m.effectiveW}px`;
        if (!isLastGroup) groupWrapperStyle.marginRight = `${(extraGap || 0) + ls}px`;

        children.push(h('div', { key: gi, className: 'flex flex-col items-center', style: groupWrapperStyle }, ...groupChildren));
    });

    return h('div', { className: 'flex items-baseline', style: { opacity: fadeOpacity, position: 'relative' } }, ...children);
}
