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
        span.style.whiteSpace = 'pre';
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

    const fs = config.fontSize !== undefined ? config.fontSize : 64;
    const ls = config.letterSpacing !== undefined ? config.letterSpacing : 9;
    const rfs = config.rubySize !== undefined ? config.rubySize : 26;
    const rls = config.rubyLetterSpacing !== undefined ? config.rubyLetterSpacing : 5;
    const r2fs = config.ruby2Size !== undefined ? config.ruby2Size : 20;
    const r2ls = config.ruby2LetterSpacing !== undefined ? config.ruby2LetterSpacing : 4;
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
            // 完美支持负值 letterSpacing 计算
            w += (charCount > 0 ? charCount - 1 : 0) * letterSpacing;
        } else if (ruby) {
            const chars = [...ruby];
            for (let ci = 0; ci < chars.length; ci++) {
                w += measureTotalWidth(chars[ci], fontSize, ff, 0, fontWeight);
            }
            w += (chars.length > 0 ? chars.length - 1 : 0) * letterSpacing;
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
        baseW += (g.chars.length > 0 ? g.chars.length - 1 : 0) * ls;

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

// ---- 动态探测不同字体的真实基线偏移 ----
// Canvas fillText 的 y 是基线位置，需要知道 DOM 里基线离行框顶部多少 px
// lineHeight: 可选，默认 1.2（主字用 1.2，注音用 1.1）
function measureBaselineOffset(fontSize, fontFamily, fontWeight, lineHeight) {
    const lh = lineHeight !== undefined ? lineHeight : 1.2;
    const key = `baseline|${fontSize}|${fontFamily}|${fontWeight}|${lh}`;
    if (glyphCache[key]) return glyphCache[key];
    try {
        const div = document.createElement('div');
        div.style.fontFamily = fontFamily;
        div.style.fontSize = `${fontSize}px`;
        div.style.fontWeight = fontWeight || 'normal';
        div.style.lineHeight = String(lh);
        div.style.position = 'fixed';
        div.style.left = '-9999px';
        div.style.visibility = 'hidden';

        // 方块字测量基线最准
        const span = document.createElement('span');
        span.textContent = '国';
        div.appendChild(span);

        // 零高度标尺，verticalAlign: baseline 让它正好坐在基线上
        const baselineMarker = document.createElement('span');
        baselineMarker.style.display = 'inline-block';
        baselineMarker.style.width = '1px';
        baselineMarker.style.height = '0px';
        baselineMarker.style.verticalAlign = 'baseline';
        div.appendChild(baselineMarker);

        document.body.appendChild(div);

        // 标尺 top - 外框 top = 基线离行框顶部的物理像素
        const divRect = div.getBoundingClientRect();
        const markerRect = baselineMarker.getBoundingClientRect();
        const offset = markerRect.top - divRect.top;

        document.body.removeChild(div);
        return (glyphCache[key] = offset);
    } catch (e) {
        // 降级：约 fontSize * 0.88 + halfLeading
        return fontSize * 0.88 + fontSize * (lh - 1) / 2;
    }
}

// 标题的 DOM/Canvas 共用测量结果：DOM 定义字符宽度与基线，两个渲染器只消费布局。
function measureSongTitleLayout(layout) {
    const groups = Array.isArray(layout) ? layout : [];
    return groups.map(group => {
        const style = group.style || SONG_TITLE_INFO_STYLE_DEFAULTS;
        const fontWeight = style.fontBold ? 'bold' : 'normal';
        const baselineOffset = measureBaselineOffset(
            style.fontSize,
            style.fontFamily,
            fontWeight,
            1,
        );
        const lines = (Array.isArray(group.lines) ? group.lines : []).map(line => {
            const chars = [...line];
            const widths = chars.map(char => measureTotalWidth(
                char,
                style.fontSize,
                style.fontFamily,
                0,
                fontWeight,
            ));
            const totalWidth = widths.reduce((sum, width) => sum + width, 0)
                + Math.max(0, chars.length - 1) * style.letterSpacing;
            return { chars, widths, totalWidth };
        });
        const paragraphWidth = Math.max(0, ...lines.map(line => line.totalWidth));

        return {
            ...group,
            style,
            fontWeight,
            baselineOffset,
            paragraphWidth,
            measuredLines: lines.map((line, lineIndex) => {
                const topY = style.y + lineIndex * (style.fontSize + style.lineSpacing);
                return {
                    ...line,
                    startX: getSongTitleLineStartX(
                        style.align,
                        style.x,
                        line.totalWidth,
                        paragraphWidth,
                    ),
                    topY,
                    baselineY: topY + baselineOffset,
                };
            }),
        };
    });
}

// ---- 动态探测 lineHeight 撑起的真实物理外框高度 ----
function measureBoxHeight(fontSize, fontFamily, fontWeight, lineHeight) {
    const lh = lineHeight !== undefined ? lineHeight : 1.2;
    const key = `boxH|${fontSize}|${fontFamily}|${fontWeight}|${lh}`;
    if (glyphCache[key]) return glyphCache[key];
    try {
        const span = document.createElement('span');
        span.textContent = '国';
        span.style.fontFamily = fontFamily;
        span.style.fontSize = `${fontSize}px`;
        span.style.fontWeight = fontWeight || 'normal';
        span.style.lineHeight = String(lh);
        span.style.padding = '0';
        span.style.margin = '0';
        span.style.display = 'inline-block';
        span.style.position = 'fixed';
        span.style.visibility = 'hidden';

        document.body.appendChild(span);
        const rect = span.getBoundingClientRect();
        document.body.removeChild(span);

        return (glyphCache[key] = rect.height);
    } catch (e) {
        return fontSize * lh;
    }
}
