// ==================== DOM 实时预览渲染组件 ====================
// 使用 React.createElement，无需 JSX/Babel

const h = React.createElement;

// ---- CharMask: 逐字 clip-path 遮罩（支持 N 角色垂直等分分层） ----
function CharMask({ text, progress, fontSize, letterSpacing, fontFamily, fontWeight,
    colorBefore, colorAfter, strokeBefore, strokeAfter, strokeWidth,
    roleB_colorBefore, roleB_colorAfter, roleB_strokeBefore, roleB_strokeAfter,
    roleColors }) {
    const pct = progress;
    const sw = strokeWidth || Math.max(1, Math.round(fontSize * 0.12));
    const safePad = sw;
    const rightClip = 100 - pct;

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
        const segPct = 100 / N;
        const children = [h('span', { style: { ...textBase, color: 'transparent' } }, text)];
        for (let i = 0; i < N; i++) {
            const rc = allRC[i];
            const sB = genStroke(rc.strokeColorBefore, sw), sA = genStroke(rc.strokeColorAfter, sw);
            const topPct = i * segPct, bottomPct = 100 - (i + 1) * segPct;
            children.push(h('span', { style: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, clipPath: `inset(${topPct}% 0 ${bottomPct}% 0)` } },
                h('span', { style: { ...textBase, color: rc.colorBefore, textShadow: sB, position: 'absolute', top: 0, left: 0 } }, text),
                h('span', { style: { ...textBase, color: rc.colorAfter, textShadow: sA, position: 'absolute', top: 0, left: 0, clipPath: `inset(-50% ${rightClip}% -50% -${safePad}px)` } }, text)));
        }
        return h('span', { style: { position: 'relative', display: 'inline-block', verticalAlign: 'bottom', margin: `-${safePad}px` } }, ...children);
    }

    const shadowB = genStroke(strokeBefore, sw), shadowA = genStroke(strokeAfter, sw);
    return h('span', { style: { position: 'relative', display: 'inline-block', verticalAlign: 'bottom', margin: `-${safePad}px` } },
        h('span', { style: { ...textBase, color: colorBefore, textShadow: shadowB } }, text),
        h('span', { style: { ...textBase, color: colorAfter, textShadow: shadowA, position: 'absolute', top: 0, left: 0, clipPath: `inset(-50% ${rightClip}% -50% -${safePad}px)` } }, text));
}

// ---- RubyMask: 注音逐字 clip-path（支持 N 角色垂直等分分层） ----
function RubyMask({ text, progress, fontSize, letterSpacing, fontFamily, fontWeight,
    colorBefore, colorAfter, strokeBefore, strokeAfter, strokeWidth,
    roleB_colorBefore, roleB_colorAfter, roleB_strokeBefore, roleB_strokeAfter,
    roleColors }) {
    if (!text) return null;
    const pct = progress;
    const sw = strokeWidth || Math.max(0.5, fontSize * 0.1);
    const safePad = Math.max(1, sw);
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

    let allRC = roleColors;
    if (!allRC || allRC.length === 0) {
        const p = { colorBefore, colorAfter, strokeColorBefore: strokeBefore, strokeColorAfter: strokeAfter };
        const s = (roleB_colorBefore || roleB_colorAfter) ? { colorBefore: roleB_colorBefore, colorAfter: roleB_colorAfter, strokeColorBefore: roleB_strokeBefore, strokeColorAfter: roleB_strokeAfter } : null;
        allRC = s ? [p, s] : [p];
    }
    const N = allRC.length;
    const marginStyle = { marginTop: -safePad, marginBottom: -safePad, marginLeft: -safePad, marginRight: -(safePad + (letterSpacing || 0)) };

    if (N >= 2) {
        const segPct = 100 / N;
        const children = [h('span', { style: { ...textBase, color: 'transparent' } }, text)];
        for (let i = 0; i < N; i++) {
            const rc = allRC[i];
            const sB = genStroke(rc.strokeColorBefore, sw), sA = genStroke(rc.strokeColorAfter, sw);
            const topPct = i * segPct, bottomPct = 100 - (i + 1) * segPct;
            children.push(h('span', { style: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, clipPath: `inset(${topPct}% 0 ${bottomPct}% 0)` } },
                h('span', { style: { ...textBase, color: rc.colorBefore, textShadow: sB, position: 'absolute', top: 0, left: 0 } }, text),
                h('span', { style: { ...textBase, color: rc.colorAfter, textShadow: sA, position: 'absolute', top: 0, left: 0, clipPath: `inset(-50% ${rightClip}% -50% -${safePad}px)` } }, text)));
        }
        return h('span', { style: { position: 'relative', display: 'inline-block', verticalAlign: 'bottom', ...marginStyle } }, ...children);
    }

    const shadowB = genStroke(strokeBefore, sw), shadowA = genStroke(strokeAfter, sw);
    return h('span', { style: { position: 'relative', display: 'inline-block', verticalAlign: 'bottom', ...marginStyle } },
        h('span', { style: { ...textBase, color: colorBefore, textShadow: shadowB } }, text),
        h('span', { style: { ...textBase, color: colorAfter, textShadow: shadowA, position: 'absolute', top: 0, left: 0, clipPath: `inset(-50% ${rightClip}% -50% -${safePad}px)` } }, text));
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
    for (let i = 0; i < chars.length;) {
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
    let lastRoleKey = null;
    groups.forEach((g, gi) => {
        // 角色外显标签：显式角色且组合变化时，为每个角色显示标签（a+b → 两张图）
        const gRoleKeys = g.chars[0]?.roles || [];
        const gExplicit = g.chars[0]?.roleExplicit;
        const gCombinedKey = gRoleKeys.join('+');
        if (gExplicit && gCombinedKey && gCombinedKey !== lastRoleKey) {
            lastRoleKey = gCombinedKey;
            for (const rk of gRoleKeys) {
                const gProfile = (config.characterProfiles || {})[rk] || {};
                if (!gProfile.showLabel) { continue; }
                const labelScale = (gProfile.labelScale || 100) / 100;
                const labelFs = Math.round(config.fontSize * labelScale);
                const offsetY = gProfile.imageOffsetY || 0;
                if (gProfile.imageMode && gProfile.image) {
                    const marginL = (gProfile.labelMarginLeft || 0);
                    const marginR = (gProfile.labelMarginRight || 0) + config.letterSpacing + 2;
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
                    const labelColor = gProfile.displayColor || gProfile.colorBefore || config.colorBefore;
                    const labelStroke = gProfile.labelStrokeColor || config.strokeColorBefore;
                    const labelSw = config.strokeWidth;
                    // 每个字独立渲染，通过 flex gap 获得和歌词一致的字间距
                    const labelChars = [...labelText];
                    labelChars.forEach((ch, ci) => {
                        children.push(h('span', {
                            key: 'label-' + gi + '-' + rk + '-' + ci, style: {
                                fontSize: `${labelFs}px`,
                                fontFamily: config.fontFamily,
                                fontWeight: config.fontBold ? 'bold' : 'normal',
                                color: labelColor, textShadow: genStroke(labelStroke, labelSw),
                                padding: `${labelSw}px`, margin: `-${labelSw}px`,
                                display: 'inline-block', lineHeight: '1.2',
                                whiteSpace: 'pre', flexShrink: 0,
                                fontKerning: 'none', fontVariantLigatures: 'none', fontOpticalSizing: 'none',
                            }
                        }, ch));
                    });
                }
            }
        }

        const groupChildren = [];

        // 注音
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
            const rIsDual = rRoleColors.length >= 2;
            if (g.rubyChars && g.rubyChars.length > 1) {
                g.rubyChars.forEach((rc, ri) => {
                    rubyEls.push(h(RubyMask, { key: ri, text: rc.char, progress: getRubyCharProgress(g, ri), fontSize: config.rubySize, letterSpacing: rc.char.length > 1 ? config.rubyLetterSpacing : 0, fontFamily: config.fontFamily, fontWeight: config.rubyBold ? 'bold' : 'normal', colorBefore: rcb, colorAfter: rca, strokeBefore: rsb, strokeAfter: rsa, strokeWidth: rsw, roleColors: rIsDual ? rRoleColors : undefined }));
                });
            } else {
                rubyEls.push(h(RubyMask, { key: 'r', text: g.ruby, progress: getRubyProgress(g), fontSize: config.rubySize, letterSpacing: config.rubyLetterSpacing, fontFamily: config.fontFamily, fontWeight: config.rubyBold ? 'bold' : 'normal', colorBefore: rcb, colorAfter: rca, strokeBefore: rsb, strokeAfter: rsa, strokeWidth: rsw, roleColors: rIsDual ? rRoleColors : undefined }));
            }
            groupChildren.push(h('div', { key: 'ruby', className: 'flex justify-center', style: { position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', paddingBottom: `${config.rubyOffset}px`, whiteSpace: 'nowrap' } },
                h('span', { style: { display: 'inline-flex', gap: `${config.rubyLetterSpacing}px` } }, ...rubyEls)
            ));
        }

        // 主字
        const charEls = g.chars.map((c, ci) => {
            const progress = (g.rubyChars && g.rubyChars.length > 1) ? getGroupedCharProgress(c, g) : getProgress(c);
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
            });
        });
        groupChildren.push(h('div', { key: 'chars', className: 'flex items-end', style: { gap: `${config.letterSpacing}px` } }, ...charEls));

        children.push(h('div', { key: gi, className: 'flex flex-col items-center', style: { position: 'relative' } }, ...groupChildren));
    });

    return h('div', { className: 'flex items-baseline', style: { gap: `${config.letterSpacing}px`, opacity: fadeOpacity, position: 'relative' } }, ...children);
}
