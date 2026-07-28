// ==================== 走字进度计算（DOM + Canvas 共用） ====================

// 基础走字进度：基于墨水边界的 clip 百分比
// rawPctOverride: 可选覆写时间百分比（用于分段走字等高级模式）
// opts: { fs, pad, bold, letterSpacing } — 可选覆盖字号/描边/加粗/字距，用于 ruby2 等非标准注音
function calcProgress(text, time, startTime, endTime, isRuby, config, rawPctOverride, opts) {
    const rawPct = rawPctOverride !== undefined ? rawPctOverride
        : time < startTime ? 0 : time >= endTime ? 100 : ((time - startTime) / (endTime - startTime)) * 100;
    const useOpts = opts && opts.fs !== undefined;
    const pad = useOpts
        ? (opts.pad || Math.max(1, Math.round(opts.fs * 0.1)))
        : isRuby
            ? (config.rubyStrokeWidth || Math.max(1, Math.round(config.rubySize * 0.1)))
            : (config.strokeWidth || Math.round(config.fontSize * 0.12));
    const fs = useOpts ? opts.fs : (isRuby ? config.rubySize : config.fontSize);
    const fw = useOpts
        ? (opts.bold ? 'bold ' : '')
        : (isRuby ? config.rubyBold : config.fontBold) ? 'bold ' : '';
    const fontStr = `${fw}${fs}px ${config.fontFamily}`;
    const ink = measureGlyphInk(text, fontStr);
    const domW = measureTotalWidth(text, fs, config.fontFamily, useOpts ? (opts.letterSpacing || 0) : 0, fw.trim() || 'normal');
    const emW = Math.max(ink.emWidth || fs, domW);
    const total = emW + 2 * pad;
    // Canvas measureText 不支持 letter-spacing，ink.right 不含字距；但渲染时有字距，
    // 需要补偿 (text.length-1)*letterSpacing 以避免走字 100% 时右边描边被裁切
    const lsExtra = (useOpts && opts.letterSpacing && text.length > 1) ? (text.length - 1) * opts.letterSpacing : 0;
    const offsetL = pad - (ink.left || 0), offsetR = pad + (ink.right || emW) + lsExtra;
    const strokeL = offsetL - pad - 1, strokeR = offsetR + pad + 1;
    const startFrac = (strokeL / total) * 100;
    const endFrac = (strokeR / total) * 100;
    return { pct: startFrac + (rawPct / 100) * (endFrac - startFrac), total, pad, emW };
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
