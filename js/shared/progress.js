// ==================== 走字进度计算（DOM + Canvas 共用） ====================

// 基础走字进度：基于墨水边界的 clip 百分比
// rawPctOverride: 可选覆写时间百分比（用于分段走字等高级模式）
// opts: { fs, pad, bold, letterSpacing, scaleX } — 可选覆盖字号/描边/加粗/字距/字形宽度
function calcProgress(text, time, startTime, endTime, isRuby, config, rawPctOverride, opts) {
    const rawPct = rawPctOverride !== undefined ? rawPctOverride
        : time < startTime ? 0 : time >= endTime ? 100 : ((time - startTime) / (endTime - startTime)) * 100;
    const useOpts = opts && opts.fs !== undefined;
    const pad = useOpts
        ? (opts.pad !== undefined ? opts.pad : Math.max(1, Math.round(opts.fs * 0.1)))
        : isRuby
            ? (config.rubyStrokeWidth || Math.max(1, Math.round(config.rubySize * 0.1)))
            : (config.strokeWidth || Math.round(config.fontSize * 0.12));
    const fs = useOpts ? opts.fs : (isRuby ? config.rubySize : config.fontSize);
    const fw = useOpts
        ? (opts.bold ? 'bold ' : '')
        : (isRuby ? config.rubyBold : config.fontBold) ? 'bold ' : '';
    const fontStr = `${fw}${fs}px ${config.fontFamily}`;
    const ink = measureGlyphInk(text, fontStr);
    const sxRaw = useOpts && opts.scaleX !== undefined ? Number(opts.scaleX) : Number(config.charScaleX);
    const sx = Number.isFinite(sxRaw) && sxRaw > 0 ? sxRaw : 1;
    const letterSpacing = useOpts ? (opts.letterSpacing || 0) : 0;
    const glyphW = measureTotalWidth(text, fs, config.fontFamily, 0, fw.trim() || 'normal') * sx;
    const lsExtra = text.length > 1 ? (text.length - 1) * letterSpacing : 0;
    const domW = glyphW + lsExtra;
    const emW = Math.max((ink.emWidth || fs) * sx, domW);
    const total = emW + 2 * pad;
    // Canvas measureText 不支持 letter-spacing，ink.right 不含字距；但渲染时有字距，
    // 需要补偿 (text.length-1)*letterSpacing 以避免走字 100% 时右边描边被裁切
    const scaledInkRight = ink.right ? ink.right * sx : glyphW;
    const offsetR = pad + scaledInkRight + lsExtra;
    const strokeR = offsetR + pad + 1;
    // 港版字幕机风味：走字不浪费左侧留白。
    // walkStartPct（> 0 时生效）= 走字起始阈值：进度未到阈值前完全不显示走字后内容；
    // 一到阈值就从该位置（字框 %）顺跳起步，再线性走到右侧边界。
    // 阀值为 0（默认）时从墨水左缘起步（不显示左侧留白）；负值退回含留白的旧走法。
    const walkStartPct = Number(useOpts && opts.walkStartPct !== undefined
        ? opts.walkStartPct : config.walkStartPct) || 0;
    const inkStartPct = (pad + (ink.left || 0) * sx) / total * 100;
    const endFrac = Math.max(100, (strokeR / total) * 100);
    const gatePct = Math.max(0, Math.min(100, walkStartPct));
    if (rawPct < gatePct) {
        // 未到阈值：返回 0 让两侧都把走字后内容完全遮住
        return { pct: 0, total, pad, emW };
    }
    const startFrac = gatePct > 0
        ? gatePct
        : Math.max(0, inkStartPct + walkStartPct);
    const t = gatePct >= 100 ? 1 : (rawPct - gatePct) / (100 - gatePct);
    return { pct: startFrac + t * (endFrac - startFrac), total, pad, emW };
}

// 多音节注音分组 → 分段走字（兼容注音1/2时序）
function calcGroupedProgress(chars, rubyChars, charIndex, time) {
    const N = rubyChars.length;
    const K = chars.length;
    const gStart = chars[0].startTime;
    const gEnd = chars[K - 1].endTime;
    const gSpan = gEnd - gStart;

    let segIdx = 0;
    for (let si = 0; si < N; si++) {
        const segS = gStart + (rubyChars[si].offsetSec || 0);
        const segE = (si < N - 1)
            ? gStart + (rubyChars[si + 1].offsetSec || (gSpan * (si + 1) / N))
            : gEnd;
        if (time >= segS && time < segE) { segIdx = si; break; }
        if (si === N - 1 && time >= segE) { segIdx = N - 1; break; }
    }
    const segS = gStart + (rubyChars[segIdx].offsetSec || 0);
    const segE = (segIdx < N - 1)
        ? gStart + (rubyChars[segIdx + 1].offsetSec || (gSpan * (segIdx + 1) / N))
        : gEnd;
    let segProg = 0;
    if (time < gStart) segProg = 0;
    else if (time >= gEnd) segProg = 1;
    else segProg = Math.max(0, Math.min(1, (time - segS) / (segE - segS)));
    const G = ((segIdx + segProg) / N) * K * 100;
    return Math.max(0, Math.min(100, G - charIndex * 100));
}
