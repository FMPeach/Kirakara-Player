// ==================== 墨水边界测量（Canvas + DOM 双路） ====================

const glyphCache = {};

// Canvas 测量字形 ink 边界（不含 letterSpacing）
function measureGlyphInk(text, fontStr) {
    const key = `ink|${text}|${fontStr}`;
    if (glyphCache[key]) return glyphCache[key];
    try {
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d');
        ctx.font = fontStr;
        if (ctx.fontKerning !== undefined) ctx.fontKerning = 'none';
        const m = ctx.measureText(text);
        const left = m.actualBoundingBoxLeft || 0;
        const right = m.actualBoundingBoxRight || m.width;
        return (glyphCache[key] = { left, right, emWidth: m.width });
    } catch (e) {
        return { left: 0, right: 0, emWidth: 0 };
    }
}

// DOM 测量渲染总宽（含 letterSpacing）
function measureTotalWidth(text, fontSize, fontFamily, letterSpacing, fontWeight) {
    const key = `dom|${text}|${fontSize}|${fontFamily}|${letterSpacing}|${fontWeight}`;
    if (glyphCache[key]) return glyphCache[key];
    try {
        const span = document.createElement('span');
        span.textContent = text;
        span.style.position = 'fixed';
        span.style.left = '-9999px';
        span.style.fontSize = `${fontSize}px`;
        span.style.fontFamily = fontFamily;
        span.style.letterSpacing = `${letterSpacing}px`;
        span.style.fontWeight = fontWeight || 'normal';
        span.style.fontKerning = 'none';
        span.style.fontVariantLigatures = 'none';
        span.style.fontOpticalSizing = 'none';
        span.style.whiteSpace = 'nowrap';
        document.body.appendChild(span);
        const w = span.scrollWidth;
        document.body.removeChild(span);
        return (glyphCache[key] = w);
    } catch (e) {
        return fontSize;
    }
}

// DOM text-shadow 32向描边生成
const strokeCache = {};
function genStroke(color, width) {
    if (width <= 0 || !color) return 'none';
    const key = `${color}_${width}`;
    if (strokeCache[key]) return strokeCache[key];
    const parts = [];
    const steps = 32;
    for (let r = 1; r <= width; r += 0.5) {
        for (let t = 0; t < 360; t += 360 / steps) {
            const rad = t * Math.PI / 180;
            parts.push(`${(r * Math.cos(rad)).toFixed(2)}px ${(r * Math.sin(rad)).toFixed(2)}px 0px ${color}`);
        }
    }
    return (strokeCache[key] = parts.join(','));
}

// ---- 注音避让布局计算 ----
// 输入: groups[] (每个 group 含 chars, ruby, rubyChars, ruby2, ruby2Chars)
// 输出: { metrics: [{ baseW, rubyW, effectiveW, isolatePad }], extraGaps: number[] }
//   rubyW: 注音1与注音2的宽度取最大值（避让跟随更宽的那个）
//   effectiveW: Isolate 后该组的有效宽度
//   isolatePad: 主字两侧各加的 padding (px)，让注音不超出组边界
//   extraGaps[i]: 组 i 与 i+1 之间的额外间距 (Avoidance)
function computeRubyLayout(groups, config) {
    if (!groups || groups.length === 0) return { metrics: [], extraGaps: [] };

    const fs = config.fontSize, ls = config.letterSpacing;
    const rfs = config.rubySize, rls = config.rubyLetterSpacing || 0;
    const r2fs = config.ruby2Size, r2ls = config.ruby2LetterSpacing || 0;
    const ff = config.fontFamily;
    const fw = config.fontBold ? 'bold' : 'normal';
    const rfw = config.rubyBold ? 'bold' : 'normal';
    const r2fw = config.ruby2Bold ? 'bold' : 'normal';

    // 辅助：测量注音字符串宽度
    const measureRubyWidth = (ruby, rubyChars, fontSize, letterSpacing, fontWeight) => {
        let w = 0;
        if (rubyChars && rubyChars.length > 1) {
            let charCount = 0;
            for (let ri = 0; ri < rubyChars.length; ri++) {
                const chars = [...rubyChars[ri].char];
                for (let ci = 0; ci < chars.length; ci++) {
                    w += measureTotalWidth(chars[ci], fontSize, ff, 0, fontWeight);
                    charCount++;
                }
            }
            w += Math.max(0, charCount - 1) * letterSpacing;
        } else if (ruby) {
            const chars = [...ruby];
            for (let ci = 0; ci < chars.length; ci++) {
                w += measureTotalWidth(chars[ci], fontSize, ff, 0, fontWeight);
            }
            w += Math.max(0, chars.length - 1) * letterSpacing;
        }
        return w;
    };

    // Step 1: 测量每组的主字宽、注音1宽、注音2宽
    const metrics = groups.map(g => {
        // 主字宽 (含字间距，但最后字后无间距)
        let baseW = 0;
        for (let ci = 0; ci < g.chars.length; ci++) {
            const cw = measureTotalWidth(g.chars[ci].text, fs, ff, 0, fw);
            baseW += cw;
        }
        baseW += Math.max(0, g.chars.length - 1) * ls;

        // 注音1宽
        const rubyW = measureRubyWidth(g.ruby, g.rubyChars, rfs, rls, rfw);
        // 注音2宽
        const ruby2W = measureRubyWidth(g.ruby2, g.ruby2Chars, r2fs, r2ls, r2fw);

        // 取两者最大值作为避让基准
        return { baseW, rubyW: Math.max(rubyW, ruby2W) };
    });

    // Step 2: Isolate — 注音宽度超出主字时，撑宽该组
    if (config.rubyIsolateEnabled) {
        for (const m of metrics) {
            if (m.rubyW > m.baseW) {
                m.effectiveW = m.rubyW;
                m.isolatePad = (m.rubyW - m.baseW) / 2;
            } else {
                m.effectiveW = m.baseW;
                m.isolatePad = 0;
            }
        }
    } else {
        for (const m of metrics) {
            m.effectiveW = m.baseW;
            m.isolatePad = 0;
        }
    }

    // Step 3: Avoidance — 确保相邻注音区域间距 ≥ rubyLetterSpacing（始终生效）
    // 使用代数和（非各自 max），窄注音的内部留白也算入缓冲
    // 单条 max(0, ...) 公式，连续无跳变
    const extraGaps = [];
    for (let i = 0; i < metrics.length - 1; i++) {
        const m1 = metrics[i], m2 = metrics[i + 1];
        if (m1.rubyW > 0 && m2.rubyW > 0) {
            const overflowSum = (m1.rubyW - m1.effectiveW) + (m2.rubyW - m2.effectiveW);
            extraGaps.push(Math.max(0, overflowSum / 2 + rls - ls));
        } else {
            extraGaps.push(0);
        }
    }

    return { metrics, extraGaps };
}
