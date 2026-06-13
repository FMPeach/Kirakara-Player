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
