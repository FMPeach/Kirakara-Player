// ==================== Canvas 2D 歌词渲染引擎 ====================
// 供导出流水线调用，不依赖 React

window._labelImgCache = window._labelImgCache || {};
window._lyricOffCanvas = window._lyricOffCanvas || document.createElement('canvas');
window._lyricShadowCanvas = window._lyricShadowCanvas || document.createElement('canvas');

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

    const buildRoleGradient = (dcx, yTop, yBottom, roleColors, prop, seamFadePx) => {
        if (!roleColors || roleColors.length <= 1) return roleColors[0][prop];
        const grad = dcx.createLinearGradient(0, yTop, 0, yBottom);
        const N = roleColors.length;
        const H = Math.max(1, yBottom - yTop);
        const fadeRatio = Math.min(seamFadePx / H, 0.5 / N);
        for (let i = 0; i < N; i++) {
            const color = roleColors[i][prop];
            const topPct = i / N;
            const bottomPct = (i + 1) / N;
            let startStop = topPct + (i === 0 ? 0 : fadeRatio);
            let endStop = bottomPct - (i === N - 1 ? 0 : fadeRatio);
            grad.addColorStop(Math.max(0, Math.min(1, startStop)), color);
            grad.addColorStop(Math.max(0, Math.min(1, endStop)), color);
        }
        return grad;
    };

    const drawLineCore = (dcx, line, x, y, alignRight) => {
        if (!line || !line.chars) return;

        const fs = config.fontSize !== undefined ? config.fontSize : 64;
        const ls = config.letterSpacing !== undefined ? config.letterSpacing : 9;
        const ff = config.fontFamily;
        const fw = config.fontBold ? 'bold ' : '';
        const font = `${fw}${fs}px ${ff}`;
        const sw = config.strokeWidth !== undefined ? config.strokeWidth : Math.round(fs * 0.12);

        const fwBase = config.fontBold ? 'bold' : 'normal';
        const mainBaseline = measureBaselineOffset(fs, ff, fwBase);
        const mainBoxH = measureBoxHeight(fs, ff, fwBase, 1.2);

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
                const visibleLabels = [];
                for (const rk of gRoleKeys) {
                    const profile = (config.characterProfiles || {})[rk] || {};
                    if (!profile.showLabel) continue;
                    const labelScale = (profile.labelScale || 100) / 100;
                    const labelFs = Math.round(fs * labelScale);
                    visibleLabels.push({ rk, profile, labelFs, offsetY: profile.imageOffsetY || 0 });
                }

                if (visibleLabels.length > 0) {
                    const prefix = config.roleLabelPrefix || '';
                    const sep = config.roleLabelSeparator || '';
                    const suffix = config.roleLabelSuffix || '';
                    const labelFw = config.fontBold ? 'bold ' : '';
                    const getRoleColor = (p) => p.displayColor || p.colorBefore || config.colorBefore;
                    const getRoleStroke = (p) => p.labelStrokeColor || config.strokeColorBefore;

                    const addTextLabel = (text, color, stroke, fsVal) => {
                        const chars = [...text];
                        chars.forEach((ch, ci) => {
                            const chW = measureTotalWidth(ch, fsVal, ff, 0, labelFw.trim() || 'normal');
                            layoutItems.push({ type: 'label', isImage: false, profile: null, rk: null, fs: fsVal, offsetY: 0, w: chW, text: ch, _labelColor: color, _labelStroke: stroke, _gapAfter: ci === chars.length - 1 ? ls + 2 : 0 });
                        });
                    };

                    if (prefix) addTextLabel(prefix, getRoleColor(visibleLabels[0].profile), getRoleStroke(visibleLabels[0].profile), visibleLabels[0].labelFs);
                    for (let vi = 0; vi < visibleLabels.length; vi++) {
                        const { rk, profile, labelFs, offsetY } = visibleLabels[vi];
                        if (profile.imageMode && profile.image) {
                            let img = window._labelImgCache[profile.image];
                            const marginL = profile.labelMarginLeft || 0;
                            const marginR = profile.labelMarginRight || 0;
                            let imgW = labelFs;
                            if (img && img.complete && img.naturalWidth > 0) imgW = labelFs * (img.naturalWidth / img.naturalHeight);
                            layoutItems.push({ type: 'label', isImage: true, profile, rk, fs: labelFs, offsetY, w: marginL + imgW + marginR, marginL, imgW, img, _gapAfter: ls + 2 });
                        } else {
                            const labelText = profile.displayName || rk;
                            const chars = [...labelText];
                            chars.forEach((ch, ci) => {
                                const chW = measureTotalWidth(ch, labelFs, ff, 0, labelFw.trim() || 'normal');
                                layoutItems.push({ type: 'label', isImage: false, profile, rk, fs: labelFs, offsetY, w: chW, text: ch, _gapAfter: ci === chars.length - 1 ? ls + 2 : 0 });
                            });
                        }
                        if (sep && vi < visibleLabels.length - 1) addTextLabel(sep, getRoleColor(profile), getRoleStroke(profile), labelFs);
                    }
                    if (suffix) {
                        const last = visibleLabels[visibleLabels.length - 1];
                        addTextLabel(suffix, getRoleColor(last.profile), getRoleStroke(last.profile), last.labelFs);
                    }
                }
            }

            let groupW = 0;
            const layoutChars = [];
            for (let ci = 0; ci < g.chars.length; ci++) {
                const c = g.chars[ci];
                let charW = measureTotalWidth(c.text, fs, ff, 0, fw.trim() || 'normal');
                if (charW <= 0) { dcx.font = font; charW = dcx.measureText(c.text).width; }
                if (charW <= 0) charW = fs * 0.3;
                layoutChars.push({ ...c, w: charW });
                groupW += charW; 
                if (ci < g.chars.length - 1) groupW += ls;
            }
            layoutItems.push({ type: 'group', chars: layoutChars, ruby: g.ruby, rubyChars: g.rubyChars, ruby2: g.ruby2, ruby2Chars: g.ruby2Chars, w: groupW });
        }

        const { metrics: rubyMetrics, extraGaps: rubyExtraGaps } = computeRubyLayout(groups, config);
        let groupIdx = 0;
        for (const item of layoutItems) {
            if (item.type === 'group') {
                const m = rubyMetrics[groupIdx] || {};
                if (m.isolatePad > 0) item.w = m.effectiveW;
                item.isolatePad = m.isolatePad || 0;
                groupIdx++;
            }
        }

        let totalLineWidth = 0;
        for (let i = 0; i < layoutItems.length; i++) {
            const item = layoutItems[i];
            totalLineWidth += item.w;
            if (i < layoutItems.length - 1) totalLineWidth += (item.type === 'label' && item._gapAfter != null) ? item._gapAfter : ls;
        }
        totalLineWidth += rubyExtraGaps.reduce((s, g) => s + g, 0);
        let cursorX = alignRight ? (1280 - config.line2Right - totalLineWidth) : x;

        groupIdx = 0;
        for (const item of layoutItems) {
            item.x = cursorX;
            if (item.type === 'label') {
                item.drawX = item.isImage ? cursorX + (item.marginL || 0) : cursorX;
                cursorX += item.w + ((item._gapAfter != null) ? item._gapAfter : ls);
            } else if (item.type === 'group') {
                let cx = cursorX + (item.isolatePad || 0);
                for (const c of item.chars) { c.x = cx; cx += c.w + ls; }
                cursorX += item.w + ls + (rubyExtraGaps[groupIdx] || 0);
                groupIdx++;
            }
        }

        const angleRad = ((config.shadowAngle || 0) * Math.PI) / 180;
        const sOffsetX = (config.shadowDistance || 0) * Math.cos(angleRad);
        const sOffsetY = (config.shadowDistance || 0) * Math.sin(angleRad);
        const sBlur = config.shadowBlur || 0;
        const seamFadePx = 0;

        // ---- 双层渲染系统：主字层与阴影层彻底物理隔离 ----
        // 核心理念：将整个行的阴影以全锐利无模糊的方式画在离屏 Canvas 上（先走字，进行物理几何切割），
        // 最后再一次性把这张离屏 Canvas 给贴入主画布，贴上的瞬间施加 filter: blur
        // 这样切割的边缘 (刀痕) 也会得到完美的羽化晕染，完全匹配 DOM 的渲染行为！
        const renderPass = (mode, tCtx) => {
            if (mode === 'main') {
                drawIndicator(tCtx, line, x, y - mainBaseline);
            }

            for (const item of layoutItems) {
                if (item.type === 'label') {
                    if (mode === 'shadow') continue;
                    if (item.isImage) {
                        if (item.img && item.img.complete && item.img.naturalWidth > 0) {
                            tCtx.drawImage(item.img, item.drawX, y - item.fs * 0.78 + item.offsetY, item.imgW, item.fs);
                        }
                    } else {
                        const labelColor = item._labelColor || (item.profile && (item.profile.displayColor || item.profile.colorBefore)) || config.colorBefore;
                        const labelStroke = item._labelStroke || (item.profile && item.profile.labelStrokeColor) || config.strokeColorBefore;
                        const labelFw = config.fontBold ? 'bold ' : '';
                        tCtx.font = `${labelFw}${item.fs}px ${ff}`;
                        applyCanvasTextMode(tCtx);
                        drawShadowStrokeText(tCtx, item.text, item.drawX, y, labelStroke, config.strokeWidth);
                        tCtx.fillStyle = labelColor; tCtx.fillText(item.text, item.drawX, y);
                    }
                } 
                else if (item.type === 'group') {
                    const groupStartX = item.chars[0].x;
                    const groupEndX = item.chars[item.chars.length - 1].x;
                    const groupEndW = item.chars[item.chars.length - 1].w;
                    const groupCenterX = (groupStartX + groupEndX + groupEndW) / 2;
                    const gStart = item.chars[0].startTime;
                    const gEnd = item.chars[item.chars.length - 1].endTime;
                    const rRoleColors = getRoleColors(item.chars[0], config);

                    // 注音 1：顶部
                    if (item.ruby && item.chars.length > 0) {
                        const rfs = config.rubySize !== undefined ? config.rubySize : 26;
                        const rls = config.rubyLetterSpacing !== undefined ? config.rubyLetterSpacing : 5;
                        const rlw = config.rubyStrokeWidth !== undefined ? config.rubyStrokeWidth : Math.max(1, Math.round(rfs * 0.1));
                        const rShadowSw = rlw + (config.shadowSpread || 0);
                        const rfw = config.rubyBold ? 'bold ' : '';
                        tCtx.font = `${rfw}${rfs}px ${ff}`;
                        applyCanvasTextMode(tCtx);

                        const rfwBase = config.rubyBold ? 'bold' : 'normal';
                        const rBaseline = measureBaselineOffset(rfs, ff, rfwBase, 1.1);
                        const ry = y - mainBaseline - (config.rubyOffset !== undefined ? config.rubyOffset : 4) - (rfs * 1.1 - rBaseline);
                        const rTextTop = ry - rfs * 0.88;
                        const rBoxHeight = rfs * 1.0;

                        let rgStrokeB, rgColorB, rgStrokeA, rgColorA;
                        if (mode === 'main') {
                            rgStrokeB = buildRoleGradient(tCtx, rTextTop, rTextTop + rBoxHeight, rRoleColors, 'strokeBefore', seamFadePx);
                            rgColorB  = buildRoleGradient(tCtx, rTextTop, rTextTop + rBoxHeight, rRoleColors, 'colorBefore', seamFadePx);
                            rgStrokeA = buildRoleGradient(tCtx, rTextTop, rTextTop + rBoxHeight, rRoleColors, 'strokeAfter', seamFadePx);
                            rgColorA  = buildRoleGradient(tCtx, rTextTop, rTextTop + rBoxHeight, rRoleColors, 'colorAfter', seamFadePx);
                        }

                        const processRuby = (ch, cw, chInfo, rxCursor) => {
                            if (mode === 'shadow') {
                                const sCx = rxCursor + sOffsetX, sCy = ry + sOffsetY;
                                tCtx.save();
                                // 注意！这里不再施加任何 filter，我们要的是生切！所有的模糊留到贴图步骤！
                                drawShadowStrokeText(tCtx, ch, sCx, sCy, config.shadowColorBefore || '#000000', rShadowSw);
                                tCtx.fillStyle = config.shadowColorBefore || '#000000'; tCtx.fillText(ch, sCx, sCy);

                                const shadowStarted = chInfo.startFrac !== undefined ? (chInfo.pct > chInfo.startFrac + 0.001) : (chInfo.pct > 0);
                                const shadowDone = chInfo.endFrac !== undefined ? (chInfo.pct >= chInfo.endFrac - 0.001) : (chInfo.pct >= 100);

                                if (!shadowStarted) {
                                } else if (shadowDone) {
                                    drawShadowStrokeText(tCtx, ch, sCx, sCy, config.shadowColorAfter || '#000000', rShadowSw);
                                    tCtx.fillStyle = config.shadowColorAfter || '#000000'; tCtx.fillText(ch, sCx, sCy);
                                } else {
                                    tCtx.save(); tCtx.beginPath();
                                    tCtx.rect(rxCursor - rfs, ry - rfs * 2.5, (rfs - chInfo.pad) + (chInfo.pct / 100) * chInfo.total, rfs * 4);
                                    tCtx.clip();
                                    drawShadowStrokeText(tCtx, ch, sCx, sCy, config.shadowColorAfter || '#000000', rShadowSw);
                                    tCtx.fillStyle = config.shadowColorAfter || '#000000'; tCtx.fillText(ch, sCx, sCy);
                                    tCtx.restore();
                                }
                                tCtx.restore();
                            } else {
                                drawShadowStrokeText(tCtx, ch, rxCursor, ry, rgStrokeB, rlw);
                                tCtx.fillStyle = rgColorB; tCtx.fillText(ch, rxCursor, ry);
                                if (chInfo.pct > chInfo.startFrac + 0.001) {
                                    tCtx.save(); tCtx.beginPath();
                                    tCtx.rect(rxCursor - rfs, ry - rfs * 2.5, (rfs - chInfo.pad) + (chInfo.pct / 100) * chInfo.total, rfs * 4);
                                    tCtx.clip();
                                    drawShadowStrokeText(tCtx, ch, rxCursor, ry, rgStrokeA, rlw);
                                    tCtx.fillStyle = rgColorA; tCtx.fillText(ch, rxCursor, ry);
                                    tCtx.restore();
                                }
                            }
                        };

                        if (item.rubyChars && item.rubyChars.length > 1) {
                            const rfwStr = config.rubyBold ? 'bold' : 'normal';
                            const flatChars = [];
                            for (const rc of item.rubyChars) {
                                const chars = [...rc.char];
                                for (const ch of chars) flatChars.push({ char: ch, offsetSec: rc.offsetSec, width: measureTotalWidth(ch, rfs, ff, 0, rfwStr) });
                            }
                            const rTotalW = flatChars.reduce((s, fc) => s + fc.width, 0) + (flatChars.length > 0 ? flatChars.length - 1 : 0) * rls;
                            let rxCursor = groupCenterX - rTotalW / 2;
                            let flatIdx = 0;
                            for (let ri = 0; ri < item.rubyChars.length; ri++) {
                                const rc = item.rubyChars[ri];
                                const rcStart = gStart + (rc.offsetSec || (gEnd - gStart) * ri / item.rubyChars.length);
                                const rcEnd = (ri + 1 < item.rubyChars.length) ? gStart + (item.rubyChars[ri + 1].offsetSec || (gEnd - gStart) * (ri + 1) / item.rubyChars.length) : gEnd;
                                const rcSpan = rcEnd - rcStart;
                                const subChars = [...rc.char];
                                for (let si = 0; si < subChars.length; si++) {
                                    const ch = subChars[si];
                                    const cw = flatChars[flatIdx++].width;
                                    const chStart = rcStart + rcSpan * si / subChars.length;
                                    const chEnd = rcStart + rcSpan * (si + 1) / subChars.length;
                                    const chInfo = calcProgress(ch, time, chStart, chEnd, true, config);
                                    processRuby(ch, cw, chInfo, rxCursor);
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
                                processRuby(ch, cw, chInfo, rxCursor);
                                rxCursor += cw + rls;
                            }
                        }
                    }

                    // 注音 2：下方
                    if (item.ruby2 && item.chars.length > 0) {
                        const r2fs = config.ruby2Size !== undefined ? config.ruby2Size : 20;
                        const r2ls = config.ruby2LetterSpacing !== undefined ? config.ruby2LetterSpacing : 4;
                        const r2lw = config.ruby2StrokeWidth !== undefined ? config.ruby2StrokeWidth : Math.max(1, Math.round(r2fs * 0.1));
                        const r2ShadowSw = r2lw + (config.shadowSpread || 0);
                        const r2fw = config.ruby2Bold ? 'bold ' : '';
                        tCtx.font = `${r2fw}${r2fs}px ${ff}`;
                        applyCanvasTextMode(tCtx);

                        const botDist = mainBoxH - mainBaseline;
                        const r2fwBase = config.ruby2Bold ? 'bold' : 'normal';
                        const r2Baseline = measureBaselineOffset(r2fs, ff, r2fwBase, 1.1);
                        const r2y = y + botDist + (config.ruby2Offset !== undefined ? config.ruby2Offset : 4) + r2Baseline;
                        const r2TextTop = r2y - r2fs * 0.88;
                        const r2BoxHeight = r2fs * 1.0;

                        let r2gStrokeB, r2gColorB, r2gStrokeA, r2gColorA;
                        if (mode === 'main') {
                            r2gStrokeB = buildRoleGradient(tCtx, r2TextTop, r2TextTop + r2BoxHeight, rRoleColors, 'strokeBefore', seamFadePx);
                            r2gColorB  = buildRoleGradient(tCtx, r2TextTop, r2TextTop + r2BoxHeight, rRoleColors, 'colorBefore', seamFadePx);
                            r2gStrokeA = buildRoleGradient(tCtx, r2TextTop, r2TextTop + r2BoxHeight, rRoleColors, 'strokeAfter', seamFadePx);
                            r2gColorA  = buildRoleGradient(tCtx, r2TextTop, r2TextTop + r2BoxHeight, rRoleColors, 'colorAfter', seamFadePx);
                        }

                        const processRuby2Block = (chars, charWidths, r2xCursor, rawPct, visualW) => {
                            if (mode === 'shadow') {
                                tCtx.save();
                                let cxStrokeB = r2xCursor + sOffsetX;
                                for (let i = 0; i < chars.length; i++) {
                                    drawShadowStrokeText(tCtx, chars[i], cxStrokeB, r2y + sOffsetY, config.shadowColorBefore || '#000000', r2ShadowSw);
                                    tCtx.fillStyle = config.shadowColorBefore || '#000000'; tCtx.fillText(chars[i], cxStrokeB, r2y + sOffsetY);
                                    cxStrokeB += charWidths[i] + r2ls;
                                }
                                const shadowStarted = rawPct > 0.001;
                                const shadowDone = rawPct >= 99.999;
                                if (!shadowStarted) {
                                } else if (shadowDone) {
                                    let cxStrokeA = r2xCursor + sOffsetX;
                                    for (let i = 0; i < chars.length; i++) {
                                        drawShadowStrokeText(tCtx, chars[i], cxStrokeA, r2y + sOffsetY, config.shadowColorAfter || '#000000', r2ShadowSw);
                                        tCtx.fillStyle = config.shadowColorAfter || '#000000'; tCtx.fillText(chars[i], cxStrokeA, r2y + sOffsetY);
                                        cxStrokeA += charWidths[i] + r2ls;
                                    }
                                } else {
                                    tCtx.save(); tCtx.beginPath();
                                    const r2ClipL = r2xCursor - r2fs * 2;
                                    const r2ClipW = (r2fs * 2 - r2lw - 1) + (rawPct / 100) * (visualW + r2lw * 2 + 2);
                                    tCtx.rect(r2ClipL, r2TextTop - r2fs, r2ClipW, r2BoxHeight + r2fs * 2);
                                    tCtx.clip();
                                    let cxStrokeA = r2xCursor + sOffsetX;
                                    for (let i = 0; i < chars.length; i++) {
                                        drawShadowStrokeText(tCtx, chars[i], cxStrokeA, r2y + sOffsetY, config.shadowColorAfter || '#000000', r2ShadowSw);
                                        tCtx.fillStyle = config.shadowColorAfter || '#000000'; tCtx.fillText(chars[i], cxStrokeA, r2y + sOffsetY);
                                        cxStrokeA += charWidths[i] + r2ls;
                                    }
                                    tCtx.restore();
                                }
                                tCtx.restore();
                            } else {
                                let cxStrokeB = r2xCursor;
                                for (let i = 0; i < chars.length; i++) {
                                    drawShadowStrokeText(tCtx, chars[i], cxStrokeB, r2y, r2gStrokeB, r2lw);
                                    cxStrokeB += charWidths[i] + r2ls;
                                }
                                let cxFillB = r2xCursor;
                                for (let i = 0; i < chars.length; i++) {
                                    tCtx.fillStyle = r2gColorB; tCtx.fillText(chars[i], cxFillB, r2y);
                                    cxFillB += charWidths[i] + r2ls;
                                }
                                if (rawPct > 0.001) {
                                    tCtx.save(); tCtx.beginPath();
                                    const r2ClipL = r2xCursor - r2fs * 2;
                                    const r2ClipW = (r2fs * 2 - r2lw - 1) + (rawPct / 100) * (visualW + r2lw * 2 + 2);
                                    tCtx.rect(r2ClipL, r2TextTop - r2fs, r2ClipW, r2BoxHeight + r2fs * 2);
                                    tCtx.clip();
                                    let cxStrokeA = r2xCursor;
                                    for (let i = 0; i < chars.length; i++) {
                                        drawShadowStrokeText(tCtx, chars[i], cxStrokeA, r2y, r2gStrokeA, r2lw);
                                        cxStrokeA += charWidths[i] + r2ls;
                                    }
                                    let cxFillA = r2xCursor;
                                    for (let i = 0; i < chars.length; i++) {
                                        tCtx.fillStyle = r2gColorA; tCtx.fillText(chars[i], cxFillA, r2y);
                                        cxFillA += charWidths[i] + r2ls;
                                    }
                                    tCtx.restore();
                                }
                            }
                        };

                        if (item.ruby2Chars && item.ruby2Chars.length > 1) {
                            const r2fwStr = config.ruby2Bold ? 'bold' : 'normal';
                            const r2Syllables = [];
                            let r2TotalW = 0;
                            for (const rc of item.ruby2Chars) {
                                const chars = [...rc.char];
                                let blockW = 0;
                                const charWidths = [];
                                for (const ch of chars) {
                                    const cw = measureTotalWidth(ch, r2fs, ff, 0, r2fwStr);
                                    charWidths.push(cw);
                                    blockW += cw + r2ls;
                                }
                                r2Syllables.push({ chars, charWidths, blockW, offsetSec: rc.offsetSec });
                                r2TotalW += blockW;
                            }
                            r2TotalW -= r2ls; 
                            let r2xCursor = groupCenterX - r2TotalW / 2;

                            for (let ri = 0; ri < item.ruby2Chars.length; ri++) {
                                const syl = r2Syllables[ri];
                                const rcStart = gStart + (syl.offsetSec || (gEnd - gStart) * ri / item.ruby2Chars.length);
                                const rcEnd = (ri + 1 < item.ruby2Chars.length) ? gStart + (r2Syllables[ri + 1].offsetSec || (gEnd - gStart) * (ri + 1) / item.ruby2Chars.length) : gEnd;
                                const rcSpan = rcEnd - rcStart;
                                let rawPct = 0;
                                if (time >= rcEnd) rawPct = 100;
                                else if (time > rcStart && rcSpan > 0) rawPct = ((time - rcStart) / rcSpan) * 100;
                                processRuby2Block(syl.chars, syl.charWidths, r2xCursor, rawPct, syl.blockW - r2ls);
                                r2xCursor += syl.blockW;
                            }
                        } else {
                            const r2CharsArr = [...item.ruby2];
                            const r2fwStr2 = config.ruby2Bold ? 'bold' : 'normal';
                            const r2CharWidths = r2CharsArr.map(ch => measureTotalWidth(ch, r2fs, ff, 0, r2fwStr2));
                            const r2TotalW = r2CharWidths.reduce((s, w) => s + w, 0) + (r2CharsArr.length > 0 ? r2CharsArr.length - 1 : 0) * r2ls;
                            let r2xCursor = groupCenterX - r2TotalW / 2;
                            const r2Span = gEnd - gStart;
                            let rawPct = 0;
                            if (time >= gEnd) rawPct = 100;
                            else if (time > gStart && r2Span > 0) rawPct = ((time - gStart) / r2Span) * 100;
                            processRuby2Block(r2CharsArr, r2CharWidths, r2xCursor, rawPct, r2TotalW);
                        }
                    }

                    // 主字
                    tCtx.font = font;
                    applyCanvasTextMode(tCtx);
                    
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

                        if (mode === 'shadow') {
                            const shadowSw = sw + (config.shadowSpread || 0);
                            const sCx = c.x + sOffsetX;
                            const sCy = y + sOffsetY;
                            tCtx.save();
                            // 无模糊，纯锐利走字
                            drawShadowStrokeText(tCtx, c.text, sCx, sCy, config.shadowColorBefore || '#000000', shadowSw);
                            tCtx.fillStyle = config.shadowColorBefore || '#000000'; tCtx.fillText(c.text, sCx, sCy);

                            const shadowStarted = pInfo.startFrac !== undefined ? (pInfo.pct > pInfo.startFrac + 0.001) : (pInfo.pct > 0);
                            const shadowDone = pInfo.endFrac !== undefined ? (pInfo.pct >= pInfo.endFrac - 0.001) : (pInfo.pct >= 100);

                            if (!shadowStarted) {
                            } else if (shadowDone) {
                                drawShadowStrokeText(tCtx, c.text, sCx, sCy, config.shadowColorAfter || '#000000', shadowSw);
                                tCtx.fillStyle = config.shadowColorAfter || '#000000'; tCtx.fillText(c.text, sCx, sCy);
                            } else {
                                tCtx.save(); tCtx.beginPath();
                                tCtx.rect(c.x - fs, y - fs * 2.5, (fs - pInfo.pad) + (pInfo.pct / 100) * pInfo.total, fs * 4);
                                tCtx.clip();
                                drawShadowStrokeText(tCtx, c.text, sCx, sCy, config.shadowColorAfter || '#000000', shadowSw);
                                tCtx.fillStyle = config.shadowColorAfter || '#000000'; tCtx.fillText(c.text, sCx, sCy);
                                tCtx.restore();
                            }
                            tCtx.restore();
                        } else {
                            const textTop = y - fs * 0.88;
                            const boxHeight = fs * 1.0;
                            const gStrokeB = buildRoleGradient(tCtx, textTop, textTop + boxHeight, rRoleColors, 'strokeBefore', seamFadePx);
                            const gColorB  = buildRoleGradient(tCtx, textTop, textTop + boxHeight, rRoleColors, 'colorBefore', seamFadePx);
                            const gStrokeA = buildRoleGradient(tCtx, textTop, textTop + boxHeight, rRoleColors, 'strokeAfter', seamFadePx);
                            const gColorA  = buildRoleGradient(tCtx, textTop, textTop + boxHeight, rRoleColors, 'colorAfter', seamFadePx);

                            drawShadowStrokeText(tCtx, c.text, c.x, y, gStrokeB, sw);
                            tCtx.fillStyle = gColorB; tCtx.fillText(c.text, c.x, y);

                            if (pInfo.pct > pInfo.startFrac + 0.001) {
                                tCtx.save(); tCtx.beginPath();
                                tCtx.rect(c.x - fs, y - fs * 2.5, (fs - pInfo.pad) + (pInfo.pct / 100) * pInfo.total, fs * 4);
                                tCtx.clip();
                                drawShadowStrokeText(tCtx, c.text, c.x, y, gStrokeA, sw);
                                tCtx.fillStyle = gColorA; tCtx.fillText(c.text, c.x, y);
                                tCtx.restore();
                            }
                        }
                    }
                }
            }
        };

        // 按需启用双通道渲染
        if (config.shadowEnabled) {
            const sCanvas = window._lyricShadowCanvas;
            if (sCanvas.width !== dcx.canvas.width || sCanvas.height !== dcx.canvas.height) {
                sCanvas.width = dcx.canvas.width;
                sCanvas.height = dcx.canvas.height;
            }
            const sCtx = sCanvas.getContext('2d');
            sCtx.save();
            sCtx.setTransform(1, 0, 0, 1, 0, 0);
            sCtx.clearRect(0, 0, sCanvas.width, sCanvas.height);
            sCtx.restore();

            // 继承缩放等属性，在离屏 Canvas 上硬切走字
            sCtx.setTransform(dcx.getTransform());
            renderPass('shadow', sCtx);

            // 贴图回主 Canvas 的时候，一口气施加全图层柔和高斯模糊
            dcx.save();
            dcx.setTransform(1, 0, 0, 1, 0, 0);
            if (sBlur > 0) dcx.filter = `blur(${sBlur}px)`;
            dcx.drawImage(sCanvas, 0, 0);
            dcx.restore();
        }

        renderPass('main', dcx);
    };

    const drawLine = (line, x, y, alignRight) => {
        if (!line || !line.chars) return;
        const fadeOp = getFadeOpacity(line);
        if (fadeOp <= 0) return;
        if (fadeOp >= 1) {
            drawLineCore(ctx, line, x, y, alignRight);
        } else {
            const mainCanvas = ctx.canvas;
            const offC = window._lyricOffCanvas;
            if (offC.width !== mainCanvas.width || offC.height !== mainCanvas.height) {
                offC.width = mainCanvas.width;
                offC.height = mainCanvas.height;
            }
            const offCtx = offC.getContext('2d');
            
            const t = ctx.getTransform();
            offCtx.save();
            offCtx.setTransform(1, 0, 0, 1, 0, 0);
            offCtx.clearRect(0, 0, offC.width, offC.height);
            offCtx.restore();
            
            offCtx.setTransform(t);
            drawLineCore(offCtx, line, x, y, alignRight);

            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = fadeOp;
            ctx.drawImage(offC, 0, 0);
            ctx.restore();
        }
    };

    const fwBase = config.fontBold ? 'bold' : 'normal';
    const fsBase = config.fontSize !== undefined ? config.fontSize : 64;
    const realBaselineOffset = measureBaselineOffset(fsBase, config.fontFamily, fwBase);
    const topBaseOffset = realBaselineOffset;

    if (l1) drawLine(l1, config.line1X, config.line1Y + topBaseOffset, false);
    if (l2) drawLine(l2, 0, getLine2Y(config) + topBaseOffset, true);
}