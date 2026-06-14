// ==================== Canvas 2D 歌词渲染引擎 ====================
// 供导出流水线调用，不依赖 React

// 直接挂载到 window，避开 Babel 浏览器热更新时的 const 冲突天坑
window._labelImgCache = window._labelImgCache || {};

function applyCanvasTextMode(ctx) {
    if (ctx.fontKerning !== undefined) ctx.fontKerning = 'none';
    if (ctx.textRendering !== undefined) ctx.textRendering = 'optimizeSpeed';
}

// ---- 新增：全局图片预加载器 ----
function _preloadCanvasImages(config) {
    if (!config || !config.characterProfiles) return;
    for (const key in config.characterProfiles) {
        const profile = config.characterProfiles[key];
        // 只要配置里有图片，不管当前时间是多少，立马后台下载
        if (profile.imageMode && profile.image && !window._labelImgCache[profile.image]) {
            const img = new Image();
            img.src = profile.image; // 触发浏览器底层静默下载
            window._labelImgCache[profile.image] = img;
        }
    }
}

function drawLyricsOnCanvas(ctx, lyrics, time, config, entryBuf) {
    // 每次渲染前检查预加载（利用字典特性，实际上只会执行一次下载）
    _preloadCanvasImages(config);

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

    // ---- getRoleColors: 角色颜色解析 ----
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

    // 核心绘制（全不透明）
    const drawLineCore = (dcx, line, x, y, alignRight) => {
        if (!line || !line.chars) return;

        drawIndicator(dcx, line, x, y - Math.round(config.fontSize * 0.9));

        const fs = config.fontSize, ls = config.letterSpacing, ff = config.fontFamily;
        const fw = config.fontBold ? 'bold ' : '';
        const font = `${fw}${fs}px ${ff}`;
        const sw = config.strokeWidth || Math.round(fs * 0.12);

        dcx.font = font;
        applyCanvasTextMode(dcx);

        const groups = [];
        for (let i = 0; i < line.chars.length;) {
            const c = line.chars[i], span = c.rubySpan || 0;
            if (span > 1 && c.ruby) { groups.push({ ruby: c.ruby, rubyChars: c.rubyChars || null, chars: line.chars.slice(i, i + span) }); i += span; }
            else { groups.push({ ruby: c.ruby || null, rubyChars: c.rubyChars || null, chars: [c] }); i += 1; }
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

                    let labelItem = { type: 'label', profile, rk, fs: labelFs, offsetY, w: 0 };

                    if (profile.imageMode && profile.image) {
                        labelItem.isImage = true;
                        let img = window._labelImgCache[profile.image];
                        labelItem.img = img;

                        const marginL = profile.labelMarginLeft || 0;
                        const marginR = (profile.labelMarginRight || 0);
                        
                        let imgW = labelFs; 
                        if (img && img.complete && img.naturalWidth > 0) {
                            imgW = labelFs * (img.naturalWidth / img.naturalHeight);
                        }
                        labelItem.marginL = marginL;
                        labelItem.marginR = marginR;
                        labelItem.imgW = imgW;
                        labelItem.w = marginL + imgW + marginR;  // pure content width (gap added in layout)
                        layoutItems.push(labelItem);
                    } else {
                        const labelText = profile.displayName || rk;
                        const labelFw = config.fontBold ? 'bold ' : '';
                        // 每个字独立为 layout item，通过统一 gap 获得和歌词一致的字间距
                        const labelChars = [...labelText];
                        for (const ch of labelChars) {
                            const chW = measureTotalWidth(ch, labelFs, ff, 0, labelFw.trim() || 'normal');
                            layoutItems.push({ type: 'label', isImage: false, profile, rk, fs: labelFs, offsetY, w: chW, text: ch, textW: chW });
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
            layoutItems.push({ type: 'group', chars: layoutChars, ruby: g.ruby, rubyChars: g.rubyChars, w: groupW });
        }

        const totalLineWidth = layoutItems.reduce((sum, item) => sum + item.w, 0) + (layoutItems.length - 1) * ls;
        let cursorX = alignRight ? (1280 - config.line2Right - totalLineWidth) : x;

        for (const item of layoutItems) {
            item.x = cursorX;
            if (item.type === 'label') {
                item.drawX = item.isImage ? cursorX + item.marginL : cursorX;
                cursorX += item.w + ls;
            } else if (item.type === 'group') {
                let cx = cursorX;
                for (const c of item.chars) {
                    c.x = cx;
                    cx += c.w + ls; 
                }
                cursorX += item.w + ls;
            }
        }

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

                if (item.ruby && item.chars.length > 0) {
                    const rfs = config.rubySize, rls = config.rubyLetterSpacing || 0;
                    const rlw = config.rubyStrokeWidth || Math.max(1, Math.round(rfs * 0.1));
                    const rfw = config.rubyBold ? 'bold ' : '';
                    dcx.font = `${rfw}${rfs}px ${ff}`;
                    applyCanvasTextMode(dcx);

                    const gStart = item.chars[0].startTime;
                    const gEnd = item.chars[item.chars.length - 1].endTime;
                    const rChars = item.rubyChars;
                    const rRoleColors = getRoleColors(item.chars[0], config);
                    
                    const rN = rRoleColors.length;
                    const ry = y - fs * 1.045 - config.rubyOffset;
                    
                    // 【修正：对齐 CJK 字符实际字框（Em-box）】
                    // 汉字在基线上的分布大概是 -0.88 到 +0.12，总高约为 1.0em
                    const rTextTop = ry - rfs * 0.88;
                    const rBoxHeight = rfs * 1.0;

                    if (rChars && rChars.length > 1) {
                        const rfwStr = config.rubyBold ? 'bold' : 'normal';
                        const flatChars = [];
                        for (const rc of rChars) {
                            const chars = [...rc.char];
                            for (const ch of chars) {
                                flatChars.push({ char: ch, offsetSec: rc.offsetSec, width: measureTotalWidth(ch, rfs, ff, 0, rfwStr) });
                            }
                        }
                        const rTotalW = flatChars.reduce((s, fc) => s + fc.width, 0) + (flatChars.length - 1) * rls;
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

                                for (let rni = 0; rni < rN; rni++) {
                                    // 严格根据 1.0 倍 Em-box 切割，头部和尾部稍微扩展包住描边
                                    let rSegTop = rTextTop + (rni / rN) * rBoxHeight;
                                    let rSegBottom = rTextTop + ((rni + 1) / rN) * rBoxHeight;
                                    if (rni === 0) rSegTop -= (rlw + rfs * 0.5);
                                    if (rni === rN - 1) rSegBottom += (rlw + rfs * 0.5);
                                    const rCurrentSegH = rSegBottom - rSegTop;

                                    const rcColor = rRoleColors[rni];
                                    dcx.save(); dcx.beginPath();
                                    dcx.rect(rxCursor - rfs, rSegTop, rfs * 3, rCurrentSegH);
                                    dcx.clip();
                                    drawShadowStrokeText(dcx, ch, rxCursor, ry, rcColor.strokeBefore, rlw);
                                    dcx.fillStyle = rcColor.colorBefore; dcx.fillText(ch, rxCursor, ry);
                                    dcx.save(); dcx.beginPath();
                                    dcx.rect(rxCursor - rfs, ry - rfs * 2.5, (rfs - chInfo.pad) + (chInfo.pct / 100) * chInfo.total, rfs * 4);
                                    dcx.clip();
                                    drawShadowStrokeText(dcx, ch, rxCursor, ry, rcColor.strokeAfter, rlw);
                                    dcx.fillStyle = rcColor.colorAfter; dcx.fillText(ch, rxCursor, ry);
                                    dcx.restore();
                                    dcx.restore();
                                }
                                rxCursor += cw + rls;
                            }
                        }
                    } else {
                        const rCharsArr = [...item.ruby];
                        const rfwStr2 = config.rubyBold ? 'bold' : 'normal';
                        const rCharWidths = rCharsArr.map(ch => measureTotalWidth(ch, rfs, ff, 0, rfwStr2));
                        const rTotalW = rCharWidths.reduce((s, w) => s + w, 0) + (rCharsArr.length - 1) * rls;
                        let rxCursor = groupCenterX - rTotalW / 2;
                        const rSpan = gEnd - gStart;

                        for (let ri = 0; ri < rCharsArr.length; ri++) {
                            const ch = rCharsArr[ri];
                            const cw = rCharWidths[ri];
                            const chStart = gStart + rSpan * ri / rCharsArr.length;
                            const chEnd = gStart + rSpan * (ri + 1) / rCharsArr.length;
                            const chInfo = calcProgress(ch, time, chStart, chEnd, true, config);

                            for (let rni = 0; rni < rN; rni++) {
                                // 严格根据 1.0 倍 Em-box 切割，头部和尾部稍微扩展包住描边
                                let rSegTop = rTextTop + (rni / rN) * rBoxHeight;
                                let rSegBottom = rTextTop + ((rni + 1) / rN) * rBoxHeight;
                                if (rni === 0) rSegTop -= (rlw + rfs * 0.5);
                                if (rni === rN - 1) rSegBottom += (rlw + rfs * 0.5);

                                const rCurrentSegH = rSegBottom - rSegTop;

                                const rcColor = rRoleColors[rni];
                                dcx.save(); dcx.beginPath();
                                dcx.rect(rxCursor - rfs, rSegTop, rfs * 3, rCurrentSegH);
                                dcx.clip();
                                drawShadowStrokeText(dcx, ch, rxCursor, ry, rcColor.strokeBefore, rlw);
                                dcx.fillStyle = rcColor.colorBefore; dcx.fillText(ch, rxCursor, ry);
                                dcx.save(); dcx.beginPath();
                                dcx.rect(rxCursor - rfs, ry - rfs * 2.5, (rfs - chInfo.pad) + (chInfo.pct / 100) * chInfo.total, rfs * 4);
                                dcx.clip();
                                drawShadowStrokeText(dcx, ch, rxCursor, ry, rcColor.strokeAfter, rlw);
                                dcx.fillStyle = rcColor.colorAfter; dcx.fillText(ch, rxCursor, ry);
                                dcx.restore();
                                dcx.restore();
                            }
                            rxCursor += cw + rls;
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
                    } else {
                        pInfo = calcProgress(c.text, time, c.startTime, c.endTime, false, config);
                    }

                    const roleColors = getRoleColors(c, config);
                    const N = roleColors.length;
                    
                    // 【修正：对齐 CJK 字符实际字面框（Em-box）中心】
                    // 放弃 line-height 带来的偏下影响，采用纯 CJK 的 1.0em 框
                    const textTop = y - fs * 0.88;
                    const boxHeight = fs * 1.0;
                    
                    for (let ri = 0; ri < N; ri++) {
                        let segTop = textTop + (ri / N) * boxHeight;
                        let segBottom = textTop + ((ri + 1) / N) * boxHeight;
                        // 保护最外层的描边不被横向一切刀切平
                        if (ri === 0) segTop -= (sw + fs * 0.5);
                        if (ri === N - 1) segBottom += (sw + fs * 0.5);
                        const currentSegH = segBottom - segTop;

                        const rcColor = roleColors[ri];
                        dcx.save(); dcx.beginPath();
                        dcx.rect(c.x - fs, segTop, c.w + fs * 2, currentSegH);
                        dcx.clip();

                        drawShadowStrokeText(dcx, c.text, c.x, y, rcColor.strokeBefore, sw);
                        dcx.fillStyle = rcColor.colorBefore; dcx.fillText(c.text, c.x, y);

                        dcx.save(); dcx.beginPath();
                        dcx.rect(c.x - fs, y - fs * 2.5, (fs - pInfo.pad) + (pInfo.pct / 100) * pInfo.total, fs * 4);
                        dcx.clip();
                        drawShadowStrokeText(dcx, c.text, c.x, y, rcColor.strokeAfter, sw);
                        dcx.fillStyle = rcColor.colorAfter; dcx.fillText(c.text, c.x, y);
                        dcx.restore();
                        dcx.restore();
                    }
                }
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

    const topBaseOffset = config.fontSize - 2;
    const botBaseOffset = -Math.round(config.fontSize * 0.20)-2;

    if (l1) drawLine(l1, config.line1X, config.line1Y + topBaseOffset, false);
    if (l2) drawLine(l2, 0, 720 - config.line2Bottom + botBaseOffset, true);
}
