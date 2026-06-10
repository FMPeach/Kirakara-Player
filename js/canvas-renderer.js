// ==================== Canvas 2D 歌词渲染引擎 ====================
// 供导出流水线调用，不依赖 React

function drawLyricsOnCanvas(ctx, lyrics, time, config, entryBuf) {
    if (!lyrics || lyrics.length === 0) {
        if (time < 0.1) console.warn('[Canvas] drawLyricsOnCanvas: lyrics 为空！');
        return;
    }
    const EXIT_BUF = 2.0;

    // ---- 时间窗口筛选 l1/l2 ----
    let l1 = null, l2 = null, l1Para = -1, l2Para = -1, l1Walk = false, l2Walk = false;
    for (const line of lyrics) {
        const inW = time >= (line.entryTime ?? line.startTime - entryBuf) && time <= line.endTime + EXIT_BUF;
        if (!inW) continue;
        const isL1 = line.lineInParagraph % 2 === 0;
        if (isL1) {
            if (line.paragraph !== l1Para) { l1 = line; l1Para = line.paragraph; l1Walk = time < (line.walkDoneTime ?? line.endTime); }
            else if (!l1Walk) { l1 = line; l1Para = line.paragraph; l1Walk = time < (line.walkDoneTime ?? line.endTime); }
        } else {
            if (line.paragraph !== l2Para) { l2 = line; l2Para = line.paragraph; l2Walk = time < (line.walkDoneTime ?? line.endTime); }
            else if (!l2Walk) { l2 = line; l2Para = line.paragraph; l2Walk = time < (line.walkDoneTime ?? line.endTime); }
        }
    }

    const getFadeOpacity = (line) => {
        if (!line || !config.fadeEnabled) return 1;
        const dur = (config.fadeDurationMs || 666) / 1000;
        const entryT = line.entryTime ?? (line.startTime - 2);
        const exitT = line.endTime + EXIT_BUF;
        const shouldFadeIn = config.fadeParagraphOnly ? (line.isFirstInParagraph ?? false) : true;
        const shouldFadeOut = config.fadeParagraphOnly ? (line.isLastInParagraph ?? false) : true;
        let opacity = 1;
        if (shouldFadeIn && time < entryT + dur) opacity = Math.max(0, (time - entryT) / dur);
        if (shouldFadeOut && time > exitT - dur) opacity = Math.min(opacity, Math.max(0, (exitT - time) / dur));
        return Math.max(0, Math.min(1, opacity));
    };

    // 高速描边
    const drawShadowStrokeText = (dcx, text, x, y, color, width) => {
        if (width <= 0 || !color) return;
        dcx.save();
        dcx.lineJoin = 'round';
        dcx.miterLimit = 2;
        dcx.lineWidth = width * 2.2;
        dcx.strokeStyle = color;
        dcx.strokeText(text, x, y);
        dcx.restore();
    };

    const drawIndicator = (dcx, line, x, y) => {
        if (!config.indicatorEnabled || !line || !line.isFirstInParagraph || line.lineInParagraph !== 0) return;
        const ops = [1, 1, 1, 1];
        const dur = config.indicatorDuration || 4;
        const qDur = dur / 4;
        const fadeR = Math.max(0, Math.min(1, config.indicatorFadeRatio || 0));
        for (let d = 0; d < 4; d++) {
            const disappearAt = line.startTime - dur + (d + 1) * qDur;
            const fadeStart = disappearAt - qDur;
            const fadeDuration = qDur * fadeR;
            const fadeEnd = fadeStart + fadeDuration;
            if (time >= fadeEnd) ops[d] = 0;
            else if (time > fadeStart && fadeDuration > 0) ops[d] = (fadeEnd - time) / fadeDuration;
        }
        const sz = config.indicatorSize, sp = config.indicatorSpacing, sw = config.indicatorStrokeWidth || 0, r = sz / 2;
        const ox = config.indicatorOffsetX || 0, oy = (config.rubySize || 26) + (config.rubyOffset || 4) + (config.indicatorOffsetY || 8);
        const baseX = x + ox, baseY = y - oy;
        const rev = [...ops].reverse();
        const savedAlpha = dcx.globalAlpha;
        for (let d = 0; d < 4; d++) {
            if (rev[d] <= 0) continue;
            dcx.globalAlpha = savedAlpha * rev[d];
            dcx.beginPath();
            dcx.arc(baseX + d * (sz + sp) + r, baseY - sz + r, r - sw / 2, 0, Math.PI * 2);
            dcx.fillStyle = config.indicatorFillColor; dcx.fill();
            if (sw > 0) { dcx.strokeStyle = config.indicatorStrokeColor; dcx.lineWidth = sw; dcx.stroke(); }
        }
        dcx.globalAlpha = savedAlpha;
    };

    // 核心绘制（全不透明）
    const drawLineCore = (dcx, line, x, y, alignRight) => {
        if (!line || !line.chars) return;

        drawIndicator(dcx, line, x, y - config.fontSize);

        const fs = config.fontSize, ls = config.letterSpacing, ff = config.fontFamily;
        const fw = config.fontBold ? 'bold ' : '';
        const font = `${fw}${fs}px ${ff}`;
        const sw = config.strokeWidth || Math.round(fs * 0.12);
        dcx.font = font;

        const groups = [];
        for (let i = 0; i < line.chars.length;) {
            const c = line.chars[i], span = c.rubySpan || 0;
            if (span > 1 && c.ruby) { groups.push({ ruby: c.ruby, rubyChars: c.rubyChars || null, chars: line.chars.slice(i, i + span) }); i += span; }
            else { groups.push({ ruby: c.ruby || null, rubyChars: c.rubyChars || null, chars: [c] }); i += 1; }
        }

        let cx = alignRight ? 1280 - config.line2Right : x;
        const positioned = [];
        for (const g of groups) {
            const gChars = [];
            for (const c of g.chars) {
                let charW = measureTotalWidth(c.text, fs, ff, 0, fw.trim() || 'normal');
                if (charW <= 0 || /^[\s\u3000]$/.test(c.text)) charW = dcx.measureText(c.text).width;
                if (charW <= 0) charW = fs * 0.3;
                gChars.push({ ...c, _x: cx, _mw: charW });
                cx += charW + ls;
            }
            positioned.push({ ...g, chars: gChars, ruby: g.ruby, rubyChars: g.rubyChars });
        }

        if (alignRight) {
            const totalW = positioned.reduce((s, g) => s + g.chars.reduce((ss, c) => ss + c._mw + ls, 0), 0) - ls;
            let ox = 1280 - config.line2Right - totalW;
            for (const g of positioned) { for (const c of g.chars) { c._x = ox; ox += c._mw + ls; } }
        }

        for (const g of positioned) {
            if (g.ruby && g.chars.length > 0) {
                const rfs = config.rubySize, rls = config.rubyLetterSpacing || 0;
                const rlw = config.rubyStrokeWidth || Math.max(1, Math.round(rfs * 0.1));
                const rfw = config.rubyBold ? 'bold ' : '';
                dcx.font = `${rfw}${rfs}px ${ff}`;

                const gStart = g.chars[0].startTime;
                const gEnd = g.chars[g.chars.length - 1].endTime;
                const rChars = g.rubyChars;

                if (rChars && rChars.length > 1) {
                    // 逐假名独立定位+走字
                    // 使用 DOM 测量（measureTotalWidth）与 DOM 渲染器保持一致，避免 Canvas measureText 对小假名测量偏差
                    const rfwStr = config.rubyBold ? 'bold' : 'normal';
                    // 展平所有假名到单字符级别（处理 "ちょ" 这种多字符条目）
                    const flatChars = [];
                    for (const rc of rChars) {
                        const chars = [...rc.char];
                        for (const ch of chars) {
                            flatChars.push({ char: ch, offsetSec: rc.offsetSec, width: measureTotalWidth(ch, rfs, ff, 0, rfwStr) });
                        }
                    }
                    const rTotalW = flatChars.reduce((s, fc) => s + fc.width, 0) + (flatChars.length - 1) * rls;
                    const rStartX = (g.chars[0]._x + g.chars[g.chars.length - 1]._x + g.chars[g.chars.length - 1]._mw) / 2 - rTotalW / 2;
                    const ry = y - fs * 1.045 - config.rubyOffset;

                    let rxCursor = rStartX;
                    let flatIdx = 0;
                    for (let ri = 0; ri < rChars.length; ri++) {
                        const rc = rChars[ri];
                        const rcStart = gStart + (rc.offsetSec || (gEnd - gStart) * ri / rChars.length);
                        const rcEnd = (ri + 1 < rChars.length)
                            ? gStart + (rChars[ri + 1].offsetSec || (gEnd - gStart) * (ri + 1) / rChars.length)
                            : gEnd;
                        const rcSpan = rcEnd - rcStart;
                        const subChars = [...rc.char];

                        for (let si = 0; si < subChars.length; si++) {
                            const ch = subChars[si];
                            const cw = flatChars[flatIdx].width;
                            flatIdx++;
                            const chStart = rcStart + rcSpan * si / subChars.length;
                            const chEnd = rcStart + rcSpan * (si + 1) / subChars.length;
                            const chInfo = calcProgress(ch, time, chStart, chEnd, true, config);

                            drawShadowStrokeText(dcx, ch, rxCursor, ry, config.strokeColorBefore, rlw);
                            dcx.fillStyle = config.colorBefore; dcx.fillText(ch, rxCursor, ry);

                            dcx.save(); dcx.beginPath();
                            dcx.rect(rxCursor - chInfo.pad, ry - rfs * 2.5, (chInfo.pct / 100) * chInfo.total, rfs * 4);
                            dcx.clip();
                            drawShadowStrokeText(dcx, ch, rxCursor, ry, config.strokeColorAfter, rlw);
                            dcx.fillStyle = config.colorAfter; dcx.fillText(ch, rxCursor, ry);
                            dcx.restore();

                            rxCursor += cw + rls;
                        }
                    }
                } else {
                    // 整串一次性走字 — 逐字符渲染以保证 letterSpacing 生效（Canvas fillText 不支持 letterSpacing）
                    const rCharsArr = [...g.ruby];
                    const rfwStr2 = config.rubyBold ? 'bold' : 'normal';
                    const rCharWidths = rCharsArr.map(ch => measureTotalWidth(ch, rfs, ff, 0, rfwStr2));
                    const rTotalW = rCharWidths.reduce((s, w) => s + w, 0) + (rCharsArr.length - 1) * rls;
                    const rx = (g.chars[0]._x + g.chars[g.chars.length - 1]._x + g.chars[g.chars.length - 1]._mw) / 2 - rTotalW / 2;
                    const ry = y - fs * 1.045 - config.rubyOffset;
                    const rSpan = gEnd - gStart;

                    let rxCursor = rx;
                    for (let ri = 0; ri < rCharsArr.length; ri++) {
                        const ch = rCharsArr[ri];
                        const cw = rCharWidths[ri];
                        const chStart = gStart + rSpan * ri / rCharsArr.length;
                        const chEnd = gStart + rSpan * (ri + 1) / rCharsArr.length;
                        const chInfo = calcProgress(ch, time, chStart, chEnd, true, config);

                        drawShadowStrokeText(dcx, ch, rxCursor, ry, config.strokeColorBefore, rlw);
                        dcx.fillStyle = config.colorBefore; dcx.fillText(ch, rxCursor, ry);

                        dcx.save(); dcx.beginPath();
                        dcx.rect(rxCursor - chInfo.pad, ry - rfs * 2.5, (chInfo.pct / 100) * chInfo.total, rfs * 4);
                        dcx.clip();
                        drawShadowStrokeText(dcx, ch, rxCursor, ry, config.strokeColorAfter, rlw);
                        dcx.fillStyle = config.colorAfter; dcx.fillText(ch, rxCursor, ry);
                        dcx.restore();

                        rxCursor += cw + rls;
                    }
                }
            }

            dcx.font = font;
            for (let ci = 0; ci < g.chars.length; ci++) {
                    const c = g.chars[ci];
                    let pInfo;
                    if (g.rubyChars && g.rubyChars.length > 1) {
                        const rawPct = calcGroupedProgress(g.chars, g.rubyChars, ci, time);
                        pInfo = calcProgress(c.text, time, c.startTime, c.endTime, false, config, rawPct);
                    } else {
                        pInfo = calcProgress(c.text, time, c.startTime, c.endTime, false, config);
                    }

                    drawShadowStrokeText(dcx, c.text, c._x, y, config.strokeColorBefore, sw);
                    dcx.fillStyle = config.colorBefore; dcx.fillText(c.text, c._x, y);

                    dcx.save(); dcx.beginPath();
                    dcx.rect(c._x - pInfo.pad, y - fs * 2.5, (pInfo.pct / 100) * pInfo.total, fs * 4);
                    dcx.clip();
                    drawShadowStrokeText(dcx, c.text, c._x, y, config.strokeColorAfter, sw);
                    dcx.fillStyle = config.colorAfter; dcx.fillText(c.text, c._x, y);
                    dcx.restore();
                }
            }
        };

        // 离屏 canvas（淡入淡出合成用）
        let _offCanvas = null, _offCtx = null;

        const drawLine = (line, x, y, alignRight) => {
            if (!line || !line.chars) return;
            const fadeOp = getFadeOpacity(line);
            if (fadeOp <= 0) return;
            if (fadeOp >= 1) {
                drawLineCore(ctx, line, x, y, alignRight);
            } else {
                const mainCanvas = ctx.canvas;
                if (!_offCanvas || _offCanvas.width !== mainCanvas.width || _offCanvas.height !== mainCanvas.height) {
                    _offCanvas = document.createElement('canvas');
                    _offCanvas.width = mainCanvas.width;
                    _offCanvas.height = mainCanvas.height;
                    _offCtx = _offCanvas.getContext('2d');
                }
                const t = ctx.getTransform();
                _offCtx.setTransform(t);
                _offCtx.clearRect(0, 0, mainCanvas.width / (t.a || 1), mainCanvas.height / (t.d || 1));
                drawLineCore(_offCtx, line, x, y, alignRight);

                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalAlpha = fadeOp;
                ctx.drawImage(_offCanvas, 0, 0);
                ctx.restore();
            }
        };

        const topBaseOffset = config.fontSize - 1;
        const botBaseOffset = -Math.round(config.fontSize * 0.20) - 1;

        if (l1) drawLine(l1, config.line1X, config.line1Y + topBaseOffset, false);
        if (l2) drawLine(l2, 0, 720 - config.line2Bottom + botBaseOffset, true);
}
