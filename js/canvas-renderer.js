// ==================== Canvas 2D 歌词渲染引擎 ====================
// 供导出流水线调用，不依赖 React

window._labelImgCache = window._labelImgCache || {};

function applyCanvasTextMode(ctx) {
    if (ctx.fontKerning !== undefined) ctx.fontKerning = 'none';
    if (ctx.textRendering !== undefined) ctx.textRendering = 'optimizeSpeed';
}

function _preloadCanvasImages(config) {
    if (!config || !config.characterProfiles) return;
    for (const key in config.characterProfiles) {
        const profile = config.characterProfiles[key];
        if (profile.imageMode && profile.image && !window._labelImgCache[profile.image]) {
            const img = new Image();
            img.src = profile.image; 
            window._labelImgCache[profile.image] = img;
        }
    }
}

function drawLyricsOnCanvas(ctx, lyrics, time, config, entryBuf) {
    _preloadCanvasImages(config);

    if (!lyrics || lyrics.length === 0) {
        if (time < 0.1) console.warn('[Canvas] drawLyricsOnCanvas: lyrics 为空！');
        return;
    }
    const EXIT_BUF = 2.0;

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

    const drawShadowStrokeText = (dcx, text, x, y, colorOrGrad, width) => {
        if (width <= 0 || !colorOrGrad) return;
        dcx.save();
        dcx.lineJoin = 'round';
        dcx.miterLimit = 2;
        dcx.lineWidth = width * 2.2;
        dcx.strokeStyle = colorOrGrad;
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

    const getRoleColors = (c, cfg) => {
        const roles = c?.roles;
        const profiles = cfg.characterProfiles || {};
        if (!roles || roles.length === 0) {
            return [{ colorBefore: cfg.colorBefore, colorAfter: cfg.colorAfter, strokeBefore: cfg.strokeColorBefore, strokeAfter: cfg.strokeColorAfter }];
        }
        return roles.map(rn => {
            const p = profiles[rn] || {};
            return { colorBefore: p.colorBefore || cfg.colorBefore, colorAfter: p.colorAfter || cfg.colorAfter, strokeBefore: p.strokeColorBefore || cfg.strokeColorBefore, strokeAfter: p.strokeColorAfter || cfg.strokeColorAfter };
        });
    };

    // ---- 新增：构建带羽化缝隙的线性渐变色 (对齐 DOM 的 2px 过渡效果) ----
    const buildRoleGradient = (dcx, yTop, yBottom, roleColors, prop, seamFadePx) => {
        if (!roleColors || roleColors.length <= 1) return roleColors[0][prop];
        
        const grad = dcx.createLinearGradient(0, yTop, 0, yBottom);
        const N = roleColors.length;
        const H = Math.max(1, yBottom - yTop);
        // 计算 2px 对应的百分比跨度，限制最大不能超过单层厚度的一半
        const fadeRatio = Math.min(seamFadePx / H, 0.5 / N);

        for (let i = 0; i < N; i++) {
            const color = roleColors[i][prop];
            const topPct = i / N;
            const bottomPct = (i + 1) / N;
            
            // 头尾颜色不需要羽化，中间接缝处拉开 fadeRatio 距离让浏览器自动形成平滑渐变交叉
            let startStop = topPct + (i === 0 ? 0 : fadeRatio);
            let endStop = bottomPct - (i === N - 1 ? 0 : fadeRatio);
            
            grad.addColorStop(Math.max(0, Math.min(1, startStop)), color);
            grad.addColorStop(Math.max(0, Math.min(1, endStop)), color);
        }
        return grad;
    };

    // 核心绘制
    const drawLineCore = (dcx, line, x, y, alignRight) => {
        if (!line || !line.chars) return;

        const fs = config.fontSize !== undefined ? config.fontSize : 64;
        const ls = config.letterSpacing !== undefined ? config.letterSpacing : 9;
        const ff = config.fontFamily;
        const fw = config.fontBold ? 'bold ' : '';
        const font = `${fw}${fs}px ${ff}`;
        const sw = config.strokeWidth !== undefined ? config.strokeWidth : Math.round(fs * 0.12);

        // 主字测量
        const fwBase = config.fontBold ? 'bold' : 'normal';
        const mainBaseline = measureBaselineOffset(fs, ff, fwBase);
        const mainBoxH = measureBoxHeight(fs, ff, fwBase, 1.2);

        drawIndicator(dcx, line, x, y - mainBaseline);

        dcx.font = font;
        applyCanvasTextMode(dcx);

        const groups = [];
        for (let i = 0; i < line.chars.length;) {
            const c = line.chars[i], span = c.rubySpan || 0;
            if (span > 1 && (c.ruby || c.ruby2)) { groups.push({ ruby: c.ruby || null, rubyChars: c.rubyChars || null, ruby2: c.ruby2 || null, ruby2Chars: c.ruby2Chars || null, chars: line.chars.slice(i, i + span) }); i += span; }
            else { groups.push({ ruby: c.ruby || null, rubyChars: c.rubyChars || null, ruby2: c.ruby2 || null, ruby2Chars: c.ruby2Chars || null, chars: [c] }); i += 1; }
        }

        const layoutItems = [];
        let lastRoleKey = null;

        for (const g of groups) {
            const gRoleKeys = g.chars[0]?.roles || [];
            const gExplicit = g.chars[0]?.roleExplicit;
            const gCombinedKey = gRoleKeys.join('+');

            if (gExplicit && gCombinedKey && gCombinedKey !== lastRoleKey) {
                lastRoleKey = gCombinedKey;
                for (const rk of gRoleKeys) {
                    const profile = (config.characterProfiles || {})[rk] || {};
                    if (!profile.showLabel) continue;

                    const labelScale = (profile.labelScale || 100) / 100;
                    const labelFs = Math.round(fs * labelScale);
                    const offsetY = profile.imageOffsetY || 0;

                    if (profile.imageMode && profile.image) {
                        let img = window._labelImgCache[profile.image];
                        const marginL = profile.labelMarginLeft || 0;
                        const marginR = profile.labelMarginRight || 0;
                        let imgW = labelFs; 
                        if (img && img.complete && img.naturalWidth > 0) {
                            imgW = labelFs * (img.naturalWidth / img.naturalHeight);
                        }
                        layoutItems.push({ type: 'label', isImage: true, profile, rk, fs: labelFs, offsetY, w: marginL + imgW + marginR, marginL, imgW, img });
                    } else {
                        const labelText = profile.displayName || rk;
                        const labelFw = config.fontBold ? 'bold ' : '';
                        const labelChars = [...labelText];
                        for (const ch of labelChars) {
                            const chW = measureTotalWidth(ch, labelFs, ff, 0, labelFw.trim() || 'normal');
                            layoutItems.push({ type: 'label', isImage: false, profile, rk, fs: labelFs, offsetY, w: chW, text: ch });
                        }
                    }
                }
            }

            let groupW = 0;
            const layoutChars = [];
            for (let ci = 0; ci < g.chars.length; ci++) {
                const c = g.chars[ci];
                let charW = measureTotalWidth(c.text, fs, ff, 0, fw.trim() || 'normal');
                if (charW <= 0 || /^[\s\u3000]$/.test(c.text)) charW = dcx.measureText(c.text).width;
                if (charW <= 0) charW = fs * 0.3;
                layoutChars.push({ ...c, w: charW });
                groupW += charW; 
                if (ci < g.chars.length - 1) groupW += ls;
            }
            layoutItems.push({ type: 'group', chars: layoutChars, ruby: g.ruby, rubyChars: g.rubyChars, ruby2: g.ruby2, ruby2Chars: g.ruby2Chars, w: groupW });
        }

        // 注音避让布局 (Isolate + Avoidance)
        const { metrics: rubyMetrics, extraGaps: rubyExtraGaps } = computeRubyLayout(groups, config);
        let groupIdx = 0;
        for (const item of layoutItems) {
            if (item.type === 'group') {
                const m = rubyMetrics[groupIdx] || {};
                // 仅当 Isolate 实际撑宽该组时才覆盖 w，保留 Canvas 自身的空格 fallback 测量
                if (m.isolatePad > 0) item.w = m.effectiveW;
                item.isolatePad = m.isolatePad || 0;
                groupIdx++;
            }
        }

        const totalLineWidth = layoutItems.reduce((sum, item) => sum + item.w, 0)
            + (layoutItems.length - 1) * ls
            + rubyExtraGaps.reduce((s, g) => s + g, 0);
        let cursorX = alignRight ? (1280 - config.line2Right - totalLineWidth) : x;

        groupIdx = 0;
        for (const item of layoutItems) {
            item.x = cursorX;
            if (item.type === 'label') {
                item.drawX = item.isImage ? cursorX + item.marginL : cursorX;
                cursorX += item.w + ls;
            } else if (item.type === 'group') {
                let cx = cursorX + (item.isolatePad || 0);
                for (const c of item.chars) {
                    c.x = cx;
                    cx += c.w + ls; 
                }
                cursorX += item.w + ls + (rubyExtraGaps[groupIdx] || 0);
                groupIdx++;
            }
        }

        // 常量羽化像素 (值越小分层边界越硬)
        const seamFadePx = 0;

        for (const item of layoutItems) {
            if (item.type === 'label') {
                if (item.isImage) {
                    if (item.img && item.img.complete && item.img.naturalWidth > 0) {
                        dcx.drawImage(item.img, item.drawX, y - item.fs * 0.78 + item.offsetY, item.imgW, item.fs);
                    }
                } else {
                    const labelColor = item.profile.displayColor || item.profile.colorBefore || config.colorBefore;
                    const labelStroke = item.profile.labelStrokeColor || config.strokeColorBefore;
                    const labelFw = config.fontBold ? 'bold ' : '';
                    dcx.font = `${labelFw}${item.fs}px ${ff}`;
                    applyCanvasTextMode(dcx);
                    drawShadowStrokeText(dcx, item.text, item.drawX, y, labelStroke, config.strokeWidth);
                    dcx.fillStyle = labelColor;
                    dcx.fillText(item.text, item.drawX, y);
                }
            } else if (item.type === 'group') {
                const groupStartX = item.chars[0].x;
                const groupEndX = item.chars[item.chars.length - 1].x;
                const groupEndW = item.chars[item.chars.length - 1].w;
                const groupCenterX = (groupStartX + groupEndX + groupEndW) / 2;

                const gStart = item.chars[0].startTime;
                const gEnd = item.chars[item.chars.length - 1].endTime;
                const rRoleColors = getRoleColors(item.chars[0], config);

                // =====================================
                // 注音1：顶部
                // =====================================
                if (item.ruby && item.chars.length > 0) {
                    const rfs = config.rubySize !== undefined ? config.rubySize : 26;
                    const rls = config.rubyLetterSpacing !== undefined ? config.rubyLetterSpacing : 5;
                    const rlw = config.rubyStrokeWidth !== undefined ? config.rubyStrokeWidth : Math.max(1, Math.round(rfs * 0.1));
                    const rfw = config.rubyBold ? 'bold ' : '';
                    dcx.font = `${rfw}${rfs}px ${ff}`;
                    applyCanvasTextMode(dcx);

                    // 注音1 基线 
                    const rfwBase = config.rubyBold ? 'bold' : 'normal';
                    const rBaseline = measureBaselineOffset(rfs, ff, rfwBase, 1.1);
                    const ry = y - mainBaseline - (config.rubyOffset !== undefined ? config.rubyOffset : 4) - (rfs * 1.1 - rBaseline);
                    const rTextTop = ry - rfs * 0.88;
                    const rBoxHeight = rfs * 1.0;

                    // 获取注音层的独立羽化渐变色 (替代了原本繁琐切片循环)
                    const rgStrokeB = buildRoleGradient(dcx, rTextTop, rTextTop + rBoxHeight, rRoleColors, 'strokeBefore', seamFadePx);
                    const rgColorB  = buildRoleGradient(dcx, rTextTop, rTextTop + rBoxHeight, rRoleColors, 'colorBefore', seamFadePx);
                    const rgStrokeA = buildRoleGradient(dcx, rTextTop, rTextTop + rBoxHeight, rRoleColors, 'strokeAfter', seamFadePx);
                    const rgColorA  = buildRoleGradient(dcx, rTextTop, rTextTop + rBoxHeight, rRoleColors, 'colorAfter', seamFadePx);

                    const rChars = item.rubyChars;

                    if (rChars && rChars.length > 1) {
                        const rfwStr = config.rubyBold ? 'bold' : 'normal';
                        const flatChars = [];
                        for (const rc of rChars) {
                            const chars = [...rc.char];
                            for (const ch of chars) {
                                flatChars.push({ char: ch, offsetSec: rc.offsetSec, width: measureTotalWidth(ch, rfs, ff, 0, rfwStr) });
                            }
                        }
                        const rTotalW = flatChars.reduce((s, fc) => s + fc.width, 0) + (flatChars.length > 0 ? flatChars.length - 1 : 0) * rls;
                        let rxCursor = groupCenterX - rTotalW / 2;
                        
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

                                drawShadowStrokeText(dcx, ch, rxCursor, ry, rgStrokeB, rlw);
                                dcx.fillStyle = rgColorB; dcx.fillText(ch, rxCursor, ry);

                                dcx.save(); dcx.beginPath();
                                dcx.rect(rxCursor - rfs, ry - rfs * 2.5, (rfs - chInfo.pad) + (chInfo.pct / 100) * chInfo.total, rfs * 4);
                                dcx.clip();
                                drawShadowStrokeText(dcx, ch, rxCursor, ry, rgStrokeA, rlw);
                                dcx.fillStyle = rgColorA; dcx.fillText(ch, rxCursor, ry);
                                dcx.restore();

                                rxCursor += cw + rls;
                            }
                        }
                    } else {
                        const rCharsArr = [...item.ruby];
                        const rfwStr2 = config.rubyBold ? 'bold' : 'normal';
                        const rCharWidths = rCharsArr.map(ch => measureTotalWidth(ch, rfs, ff, 0, rfwStr2));
                        const rTotalW = rCharWidths.reduce((s, w) => s + w, 0) + (rCharsArr.length > 0 ? rCharsArr.length - 1 : 0) * rls;
                        let rxCursor = groupCenterX - rTotalW / 2;
                        const rSpan = gEnd - gStart;

                        for (let ri = 0; ri < rCharsArr.length; ri++) {
                            const ch = rCharsArr[ri];
                            const cw = rCharWidths[ri];
                            const chStart = gStart + rSpan * ri / rCharsArr.length;
                            const chEnd = gStart + rSpan * (ri + 1) / rCharsArr.length;
                            const chInfo = calcProgress(ch, time, chStart, chEnd, true, config);

                            drawShadowStrokeText(dcx, ch, rxCursor, ry, rgStrokeB, rlw);
                            dcx.fillStyle = rgColorB; dcx.fillText(ch, rxCursor, ry);

                            dcx.save(); dcx.beginPath();
                            dcx.rect(rxCursor - rfs, ry - rfs * 2.5, (rfs - chInfo.pad) + (chInfo.pct / 100) * chInfo.total, rfs * 4);
                            dcx.clip();
                            drawShadowStrokeText(dcx, ch, rxCursor, ry, rgStrokeA, rlw);
                            dcx.fillStyle = rgColorA; dcx.fillText(ch, rxCursor, ry);
                            dcx.restore();

                            rxCursor += cw + rls;
                        }
                    }
                }

                // 注音2（下方，罗马音等）
                if (item.ruby2 && item.chars.length > 0) {
                    const r2fs = config.ruby2Size !== undefined ? config.ruby2Size : 20;
                    const r2ls = config.ruby2LetterSpacing !== undefined ? config.ruby2LetterSpacing : 4;
                    const r2lw = config.ruby2StrokeWidth !== undefined ? config.ruby2StrokeWidth : Math.max(1, Math.round(r2fs * 0.1));
                    const r2fw = config.ruby2Bold ? 'bold ' : '';
                    dcx.font = `${r2fw}${r2fs}px ${ff}`;
                    applyCanvasTextMode(dcx);

                    // 注音2 基线
                    const botDist = mainBoxH - mainBaseline;
                    const r2fwBase = config.ruby2Bold ? 'bold' : 'normal';
                    const r2Baseline = measureBaselineOffset(r2fs, ff, r2fwBase, 1.1);
                    const r2y = y + botDist + (config.ruby2Offset !== undefined ? config.ruby2Offset : 4) + r2Baseline;
                    const r2TextTop = r2y - r2fs * 0.88;
                    const r2BoxHeight = r2fs * 1.0;

                    const r2gStrokeB = buildRoleGradient(dcx, r2TextTop, r2TextTop + r2BoxHeight, rRoleColors, 'strokeBefore', seamFadePx);
                    const r2gColorB  = buildRoleGradient(dcx, r2TextTop, r2TextTop + r2BoxHeight, rRoleColors, 'colorBefore', seamFadePx);
                    const r2gStrokeA = buildRoleGradient(dcx, r2TextTop, r2TextTop + r2BoxHeight, rRoleColors, 'strokeAfter', seamFadePx);
                    const r2gColorA  = buildRoleGradient(dcx, r2TextTop, r2TextTop + r2BoxHeight, rRoleColors, 'colorAfter', seamFadePx);

                    const r2Chars = item.ruby2Chars;

                    if (r2Chars && r2Chars.length > 1) {
                        const r2fwStr = config.ruby2Bold ? 'bold' : 'normal';
                        
                        // 【对齐修正】预先算好每一个 token block 的总宽，和单字符的独立测量值
                        const r2Syllables = [];
                        let r2TotalW = 0;
                        for (const rc of r2Chars) {
                            const chars = [...rc.char];
                            let blockW = 0;
                            const charWidths = [];
                            for (const ch of chars) {
                                // 必须测量单字符才能让分离渲染的光标准确步进
                                const cw = measureTotalWidth(ch, r2fs, ff, 0, r2fwStr);
                                charWidths.push(cw);
                                blockW += cw + r2ls;
                            }
                            r2Syllables.push({ chars, charWidths, blockW, offsetSec: rc.offsetSec });
                            r2TotalW += blockW;
                        }
                        r2TotalW -= r2ls; 
                        let r2xCursor = groupCenterX - r2TotalW / 2;

                        for (let ri = 0; ri < r2Chars.length; ri++) {
                            const syl = r2Syllables[ri];
                            const rcStart = gStart + (syl.offsetSec || (gEnd - gStart) * ri / r2Chars.length);
                            const rcEnd = (ri + 1 < r2Chars.length)
                                ? gStart + (r2Syllables[ri + 1].offsetSec || (gEnd - gStart) * (ri + 1) / r2Chars.length)
                                : gEnd;
                            const rcSpan = rcEnd - rcStart;

                            let rawPct = 0;
                            if (time >= rcEnd) rawPct = 100;
                            else if (time > rcStart && rcSpan > 0) rawPct = ((time - rcStart) / rcSpan) * 100;

                            const visualW = syl.blockW - r2ls;

                            // Pass 1: B Stroke
                            let cxStrokeB = r2xCursor;
                            for (let i = 0; i < syl.chars.length; i++) {
                                drawShadowStrokeText(dcx, syl.chars[i], cxStrokeB, r2y, r2gStrokeB, r2lw);
                                cxStrokeB += syl.charWidths[i] + r2ls;
                            }
                            // Pass 2: B Fill
                            let cxFillB = r2xCursor;
                            for (let i = 0; i < syl.chars.length; i++) {
                                dcx.fillStyle = r2gColorB; 
                                dcx.fillText(syl.chars[i], cxFillB, r2y);
                                cxFillB += syl.charWidths[i] + r2ls;
                            }

                            if (rawPct > 0) {
                                dcx.save();
                                dcx.beginPath();
                                dcx.rect(r2xCursor - r2lw - 1, r2TextTop - r2fs, (rawPct / 100) * (visualW + r2lw * 2 + 2), r2BoxHeight + r2fs * 2);
                                dcx.clip();

                                // Pass 3: A Stroke
                                let cxStrokeA = r2xCursor;
                                for (let i = 0; i < syl.chars.length; i++) {
                                    drawShadowStrokeText(dcx, syl.chars[i], cxStrokeA, r2y, r2gStrokeA, r2lw);
                                    cxStrokeA += syl.charWidths[i] + r2ls;
                                }
                                // Pass 4: A Fill
                                let cxFillA = r2xCursor;
                                for (let i = 0; i < syl.chars.length; i++) {
                                    dcx.fillStyle = r2gColorA; 
                                    dcx.fillText(syl.chars[i], cxFillA, r2y);
                                    cxFillA += syl.charWidths[i] + r2ls;
                                }
                                dcx.restore();
                            }
                            r2xCursor += syl.blockW;
                        }
                    } else {
                        // 【对齐修正】整段非切分时，完全对称 Ruby 1 的逐字遍历写法（同时带入 4 Pass 防遮挡）
                        const r2CharsArr = [...item.ruby2];
                        const r2fwStr2 = config.ruby2Bold ? 'bold' : 'normal';
                        const r2CharWidths = r2CharsArr.map(ch => measureTotalWidth(ch, r2fs, ff, 0, r2fwStr2));
                        const r2TotalW = r2CharWidths.reduce((s, w) => s + w, 0) + (r2CharsArr.length > 0 ? r2CharsArr.length - 1 : 0) * r2ls;
                        let r2xCursor = groupCenterX - r2TotalW / 2;
                        const r2Span = gEnd - gStart;

                        let rawPct = 0;
                        if (time >= gEnd) rawPct = 100;
                        else if (time > gStart && r2Span > 0) rawPct = ((time - gStart) / r2Span) * 100;

                        // Pass 1: B Stroke
                        let cxStrokeB = r2xCursor;
                        for (let i = 0; i < r2CharsArr.length; i++) {
                            drawShadowStrokeText(dcx, r2CharsArr[i], cxStrokeB, r2y, r2gStrokeB, r2lw);
                            cxStrokeB += r2CharWidths[i] + r2ls;
                        }
                        // Pass 2: B Fill
                        let cxFillB = r2xCursor;
                        for (let i = 0; i < r2CharsArr.length; i++) {
                            dcx.fillStyle = r2gColorB;
                            dcx.fillText(r2CharsArr[i], cxFillB, r2y);
                            cxFillB += r2CharWidths[i] + r2ls;
                        }

                        if (rawPct > 0) {
                            dcx.save();
                            dcx.beginPath();
                            dcx.rect(r2xCursor - r2lw - 1, r2TextTop - r2fs, (rawPct / 100) * (r2TotalW + r2lw * 2 + 2), r2BoxHeight + r2fs * 2);
                            dcx.clip();

                            // Pass 3: A Stroke
                            let cxStrokeA = r2xCursor;
                            for (let i = 0; i < r2CharsArr.length; i++) {
                                drawShadowStrokeText(dcx, r2CharsArr[i], cxStrokeA, r2y, r2gStrokeA, r2lw);
                                cxStrokeA += r2CharWidths[i] + r2ls;
                            }
                            // Pass 4: A Fill
                            let cxFillA = r2xCursor;
                            for (let i = 0; i < r2CharsArr.length; i++) {
                                dcx.fillStyle = r2gColorA;
                                dcx.fillText(r2CharsArr[i], cxFillA, r2y);
                                cxFillA += r2CharWidths[i] + r2ls;
                            }
                            dcx.restore();
                        }
                    }
                }

                dcx.font = font;
                applyCanvasTextMode(dcx);
                
                for (let ci = 0; ci < item.chars.length; ci++) {
                    const c = item.chars[ci];
                    let pInfo;
                    if (item.rubyChars && item.rubyChars.length > 1) {
                        const rawPct = calcGroupedProgress(item.chars, item.rubyChars, ci, time);
                        pInfo = calcProgress(c.text, time, c.startTime, c.endTime, false, config, rawPct);
                    } else if (item.ruby2Chars && item.ruby2Chars.length > 1) {
                        const rawPct = calcGroupedProgress(item.chars, item.ruby2Chars, ci, time);
                        pInfo = calcProgress(c.text, time, c.startTime, c.endTime, false, config, rawPct);
                    } else {
                        pInfo = calcProgress(c.text, time, c.startTime, c.endTime, false, config);
                    }

                    const roleColors = getRoleColors(c, config);
                    const textTop = y - fs * 0.88;
                    const boxHeight = fs * 1.0;

                    // 获取主字层的独立羽化渐变色 (不再有垂直切分代码，性能和画面绝赞提升)
                    const gStrokeB = buildRoleGradient(dcx, textTop, textTop + boxHeight, roleColors, 'strokeBefore', seamFadePx);
                    const gColorB  = buildRoleGradient(dcx, textTop, textTop + boxHeight, roleColors, 'colorBefore', seamFadePx);
                    const gStrokeA = buildRoleGradient(dcx, textTop, textTop + boxHeight, roleColors, 'strokeAfter', seamFadePx);
                    const gColorA  = buildRoleGradient(dcx, textTop, textTop + boxHeight, roleColors, 'colorAfter', seamFadePx);

                    drawShadowStrokeText(dcx, c.text, c.x, y, gStrokeB, sw);
                    dcx.fillStyle = gColorB; dcx.fillText(c.text, c.x, y);

                    dcx.save(); dcx.beginPath();
                    dcx.rect(c.x - fs, y - fs * 2.5, (fs - pInfo.pad) + (pInfo.pct / 100) * pInfo.total, fs * 4);
                    dcx.clip();
                    drawShadowStrokeText(dcx, c.text, c.x, y, gStrokeA, sw);
                    dcx.fillStyle = gColorA; dcx.fillText(c.text, c.x, y);
                    dcx.restore();
                }
            }
        }
    };

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

    // 动态探测真实基线偏移
    const fwBase = config.fontBold ? 'bold' : 'normal';
    const fsBase = config.fontSize !== undefined ? config.fontSize : 64;
    const realBaselineOffset = measureBaselineOffset(fsBase, config.fontFamily, fwBase);

    // L1（顶行）
    const topBaseOffset = realBaselineOffset;

    if (l1) drawLine(l1, config.line1X, config.line1Y + topBaseOffset, false);
    if (l2) drawLine(l2, 0, getLine2Y(config) + topBaseOffset, true);
}
