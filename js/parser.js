// ==================== LRC 歌词解析（@Ruby + 行内注音） ====================
// 输入: lrcRaw 文本, entryBuf, config
// 输出: lyrics[] 结构化数组

function parseTimeToSeconds(tag) {
    if (!tag) return 0;
    const clean = tag.replace(/[\[\]]/g, '');
    const parts = clean.split(/[:\.]/);
    if (parts.length === 2) {
        return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    } else if (parts.length >= 3) {
        return parseInt(parts[0]) * 60 + parseInt(parts[1]) + parseFloat('0.' + parts[2]);
    }
    return 0;
}

// 解析单组注音时轴 → { plainText, rubyChars, hasTimestamps, baseTime }
function parseKanaTimeAxis(rawKana, currentTime) {
    const kanaTimeRegex = /\[\d+:\d+(?:[:\.]\d+)?\]/g;
    let lastIdx = 0, km;
    const rubyChars = [];
    let plainText = '';
    let hasTimestamps = false;
    let baseTime = null;
    let kCurrentTime = currentTime || 0;

    while ((km = kanaTimeRegex.exec(rawKana)) !== null) {
        hasTimestamps = true;
        const ch = rawKana.slice(lastIdx, km.index);
        if (ch) {
            plainText += ch;
            if (baseTime === null) baseTime = kCurrentTime;
            rubyChars.push({ char: ch, offsetSec: Math.max(0, kCurrentTime - baseTime) });
        }
        kCurrentTime = parseTimeToSeconds(km[0]);
        if (baseTime === null) baseTime = kCurrentTime;
        lastIdx = km.index + km[0].length;
    }
    const remaining = rawKana.slice(lastIdx);
    if (remaining) {
        plainText += remaining;
        if (baseTime === null) baseTime = kCurrentTime;
        rubyChars.push({ char: remaining, offsetSec: Math.max(0, kCurrentTime - baseTime) });
    }
    return { plainText, rubyChars: rubyChars.length > 0 ? rubyChars : null, hasTimestamps, baseTime };
}

function parseLyrics(lrcRaw, entryBuf, config) {
    if (!lrcRaw.trim()) { return []; }
    window._hasDualRuby = false;
    const lines = lrcRaw.split('\n').map(l => l.trim()).filter(l => l);
    const rubyTimeRegex = /\[(\d+):(\d+)[:\.](\d+)\]/g;

    // ---- 第一遍：解析 @Ruby 标签 ----
    const rubyMap = new Map();
    lines.forEach(line => {
        const rubyMatch = line.match(/^@ruby(\d+)?=/i);
        if (!rubyMatch) return;
        const content = line.substring(rubyMatch[0].length).trim();
        const firstComma = content.indexOf(',');
        if (firstComma === -1) return;
        const kanji = content.substring(0, firstComma).trim();
        const rest = content.substring(firstComma + 1).trim();
        const parts = rest.split(',');
        const readingPart = (parts[0] || '').trim();

        const rubyChars = [];
        let plainReading = '';
        let lastIdx = 0;
        let matchR;
        const localRubyRegex = new RegExp(rubyTimeRegex.source, 'g');
        while ((matchR = localRubyRegex.exec(readingPart)) !== null) {
            const chara = readingPart.slice(lastIdx, matchR.index);
            if (chara) {
                plainReading += chara;
                const prev = rubyChars.length > 0 ? rubyChars[rubyChars.length - 1] : null;
                rubyChars.push({ char: chara, offsetSec: prev ? (prev.nextOffset || prev.offsetSec) : 0 });
            }
            const mins = parseInt(matchR[1], 10);
            const secs = parseInt(matchR[2], 10);
            const ms = parseInt(matchR[3], 10);
            const offsetSec = mins * 60 + secs + ms / 100;
            if (rubyChars.length > 0) rubyChars[rubyChars.length - 1].nextOffset = offsetSec;
            lastIdx = matchR.index + matchR[0].length;
        }
        const remaining = readingPart.slice(lastIdx);
        if (remaining) {
            plainReading += remaining;
            rubyChars.push({ char: remaining, offsetSec: rubyChars.length > 0 ? (rubyChars[rubyChars.length - 1].nextOffset || rubyChars[rubyChars.length - 1].offsetSec) : 0 });
        }
        if (rubyChars.length > 0) delete rubyChars[rubyChars.length - 1].nextOffset;

        const ranges = [];
        for (let i = 1; i < parts.length; i += 2) {
            const sRaw = (parts[i] || '').trim();
            const eRaw = (parts[i + 1] || '').trim();
            const startSec = sRaw ? parseTimeToSeconds(sRaw) : 0;
            const endSec = eRaw ? parseTimeToSeconds(eRaw) : Infinity;
            ranges.push({ start: startSec, end: endSec });
        }
        if (ranges.length === 0) ranges.push({ start: 0, end: Infinity });

        const entry = { reading: plainReading, rubyChars: rubyChars.length > 0 ? rubyChars : null, ranges };
        if (!rubyMap.has(kanji)) { rubyMap.set(kanji, [entry]); }
        else { rubyMap.get(kanji).push(entry); }
    });

    function findRuby(kanji, timeSec) {
        const entries = rubyMap.get(kanji);
        if (!entries || entries.length === 0) return null;
        for (const e of entries) {
            for (const r of e.ranges) {
                if (timeSec >= r.start && timeSec < r.end) return { reading: e.reading, rubyChars: e.rubyChars };
            }
        }
        for (const e of entries) {
            for (const r of e.ranges) {
                if (r.start === 0 && r.end === Infinity) return { reading: e.reading, rubyChars: e.rubyChars };
            }
        }
        return null;
    }

    // ---- 第二遍：构建 AST Token 流并转化为歌词行 ----
    const lyrics = [];
    let inheritedRole = null;
    
    lines.forEach(line => {
        try {
            if (/^@ruby/i.test(line)) return;
            // 判断是否包含时间戳，否则直接跳过（非歌词行）
            if (!/\[\d+:\d+(?:[:\.]\d+)?\]/.test(line)) return;

            const tokens = [];
            let curExplicit = false;
            let currentRole = inheritedRole; // 从上一行继承
            let currentTimeTag = null; // 当前上下文游标时间

            // 解析引擎 Regex:
            // 角色标签前缀为【@，分隔符为 +，后缀为】。普通【】不再触发角色。
            // 转义分支顺序敏感：\\ 必须排在 \【 前，否则 "\\【"（字面\ + 角色标签）
            // 会被 (\\【) 误匹配成单个字面【。与 C++ lrc_parser 从左往右语义一致：
            //   \\ → 字面 \; \【 → 字面 【; 其他 \x 原样保留。
            const lexer = /(\\\\)|(\\【)|(【@[^】]+】)|(\[\d+:\d+(?:[:\.]\d+)?\])|(\{([^|]+)\|([^}]+)\})|([\s\S])/g;
            let m;
            while ((m = lexer.exec(line)) !== null) {
                if (m[1]) {
                    // 0. 反斜杠转义：\\ → 字面 \
                    tokens.push({ type: 'char', text: '\\', role: currentRole, roleExplicit: curExplicit });
                    curExplicit = false;
                } else if (m[2]) {
                    // 0.5 反斜杠转义：\【 → 字面 【（不触发角色标签）
                    tokens.push({ type: 'char', text: '【', role: currentRole, roleExplicit: curExplicit });
                    curExplicit = false;
                } else if (m[3]) {
                    // 1. 角色标签：【@角色A】或【@角色A+角色B】
                    // 非法格式（按+分割后无任何角色名，如【@】、【@+】）：不解析、原样渲染
                    const candidate = m[3].replace(/^【@/, '').replace(/】$/, '').split('+').map(r => r.trim()).filter(Boolean);
                    if (candidate.length > 0) {
                        currentRole = candidate;
                        curExplicit = true;
                    } else {
                        for (let k = 0; k < m[3].length; k++) {
                            tokens.push({ type: 'char', text: m[3][k], role: currentRole, roleExplicit: curExplicit });
                            curExplicit = false;
                        }
                    }
                } else if (m[4]) {
                    // 2. 时间标签
                    currentTimeTag = parseTimeToSeconds(m[4]);
                    tokens.push({ type: 'time', time: currentTimeTag });
                } else if (m[5]) {
                    // 3. 行内注音 {漢字|注音1>注音2} 或 {漢字|注音}
                    const rawKanji = m[6];
                    const rawKana = m[7];

                    // 拆分注音1/2（> 分隔）
                    const gtIdx = rawKana.indexOf('>');
                    const rawKana1 = gtIdx >= 0 ? rawKana.slice(0, gtIdx) : rawKana;
                    const rawKana2 = gtIdx >= 0 ? rawKana.slice(gtIdx + 1) : '';
                    if (gtIdx >= 0) window._hasDualRuby = true;

                    const ka1 = parseKanaTimeAxis(rawKana1, currentTimeTag || 0);
                    const ka2 = gtIdx >= 0 ? parseKanaTimeAxis(rawKana2, currentTimeTag || 0) : null;

                    // 注音1或注音2有时间戳时注入绝对起点（优先注音1）
                    const timeKA = ka1.hasTimestamps ? ka1 : (ka2 && ka2.hasTimestamps ? ka2 : null);
                    if (timeKA && timeKA.baseTime !== null) {
                        tokens.push({ type: 'time', time: timeKA.baseTime });
                        currentTimeTag = timeKA.baseTime;
                    }

                    // 统一逐字解析汉字
                    const kanjiLexer = /(\[\d+:\d+(?:[:\.]\d+)?\])|([\s\S])/g;
                    let jm;
                    const kanjiTokens = [];
                    let charCount = 0;

                    while ((jm = kanjiLexer.exec(rawKanji)) !== null) {
                        if (jm[1]) {
                        } else if (jm[2]) {
                            kanjiTokens.push({
                                type: 'char', text: jm[2],
                                role: currentRole, roleExplicit: curExplicit
                            });
                            curExplicit = false;
                            charCount++;
                        }
                    }

                    // 注音数据挂载到汉字组首个字符
                    let firstFound = false;
                    for (const kt of kanjiTokens) {
                        if (kt.type === 'char' && !firstFound) {
                            // 【核心修复】：只要注音1或者注音2存在，都必须强制设定 rubySpan 避免连词被打碎
                            if (ka1.plainText || (ka2 && ka2.plainText)) {
                                kt.rubySpan = charCount;
                            }
                            if (ka1.plainText) { 
                                kt.ruby = ka1.plainText; 
                                kt.rubyChars = ka1.rubyChars && ka1.rubyChars.length > 1 ? ka1.rubyChars : null; 
                            }
                            if (ka2 && ka2.plainText) { 
                                kt.ruby2 = ka2.plainText; 
                                kt.ruby2Chars = ka2.rubyChars && ka2.rubyChars.length > 1 ? ka2.rubyChars : null; 
                            }
                            firstFound = true;
                        }
                        tokens.push(kt);
                    }
                    
                } else if (m[8]) {
                    // 4. 普通单字符（含空格）
                    tokens.push({ type: 'char', text: m[8], role: currentRole, roleExplicit: curExplicit });
                    curExplicit = false;
                }
            }
            
            // 更新 inheritedRole 供下一行使用
            for (let i = tokens.length - 1; i >= 0; i--) {
                if (tokens[i].type === 'char' && tokens[i].role !== null) {
                    inheritedRole = tokens[i].role;
                    break;
                }
            }

            // ---- 提取连续时轴块（完美支持 [Tag][Tag] 空隙停顿） ----
            const segments = [];
            let segStart = null;
            let segChars = [];
            
            for (let i = 0; i < tokens.length; i++) {
                const t = tokens[i];
                if (t.type === 'time') {
                    if (segChars.length > 0) {
                        // 兜底：如果行首文字前面没有时间标签，自动向前提 0.15s
                        if (segStart === null) segStart = Math.max(0, t.time - 0.15);
                        segments.push({ start: segStart, end: t.time, chars: segChars });
                    }
                    // 游标直接推进到新时间（中间无字符的话就天然形成了物理停顿区）
                    segStart = t.time;
                    segChars = [];
                } else if (t.type === 'char') {
                    segChars.push(t);
                }
            }
            // 处理行尾的最后一段文字（等待被 tailAuto 延长）
            if (segChars.length > 0) {
                if (segStart === null) segStart = 0;
                segments.push({ start: segStart, end: null, chars: segChars });
            }
            
            // ---- 把时轴块展开为平铺字符（计算绝对走字区间） ----
            const allChars = [];
            segments.forEach((seg) => {
                const end = seg.end !== null ? seg.end : seg.start + 0.5;
                const count = seg.chars.length;
                seg.chars.forEach((c, j) => {
                    allChars.push({
                        text: c.text,
                        ruby: c.ruby || null,
                        rubySpan: c.rubySpan || 0,
                        rubyChars: c.rubyChars || null,
                        ruby2: c.ruby2 || null,
                        ruby2Chars: c.ruby2Chars || null,
                        startTime: seg.start + (end - seg.start) * (j / count), // 平分本段时间
                        endTime: seg.start + (end - seg.start) * ((j + 1) / count),
                        roles: c.role,
                        roleExplicit: c.roleExplicit || false
                    });
                });
            });

            if (allChars.length > 0) {
                // ---- 后处理：挂载外置的全局 @Ruby 字典 ----
                for (let ci = 0; ci < allChars.length; ci++) {
                    // 如果这个字已经被行内注音占据（无论注音1还是注音2），直接跳过！
                    if (allChars[ci].rubySpan > 0) continue; 
                    let combined = allChars[ci].text;
                    for (let len = 2; len <= 16 && ci + len <= allChars.length; len++) {
                        let blocked = false;
                        for (let k = 1; k < len; k++) { if (allChars[ci + k].rubySpan > 0) { blocked = true; break; } }
                        if (blocked) break;
                        combined += allChars[ci + len - 1].text;
                        const r = findRuby(combined, allChars[ci].startTime);
                        if (r) { allChars[ci].ruby = r.reading; allChars[ci].rubyChars = r.rubyChars; allChars[ci].rubySpan = len; break; }
                    }
                }
                for (let ci = 0; ci < allChars.length; ci++) {
                    if (allChars[ci].rubySpan > 0) continue;
                    const r = findRuby(allChars[ci].text, allChars[ci].startTime);
                    if (r) { allChars[ci].ruby = r.reading; allChars[ci].rubyChars = r.rubyChars; allChars[ci].rubySpan = 1; }
                }

                // 判断这行末尾是否是一个时间戳（决定是否需要自动拉长尾部拖音）
                const lastToken = tokens[tokens.length - 1];
                const lineEndsWithTag = lastToken && lastToken.type === 'time';

                lyrics.push({
                    startTime: allChars[0].startTime,
                    endTime: allChars[allChars.length - 1].endTime,
                    chars: allChars,
                    tailAuto: !lineEndsWithTag,
                });
            }
        } catch (e) {
            console.warn('[Parse] 解析行出错:', line.substring(0, 60), e.message);
        }
    });

    // 行尾时间补全
    for (let i = 0; i < lyrics.length; i++) {
        const line = lyrics[i];
        if (!line.tailAuto) continue;
        const nextLine = lyrics[i + 1];
        if (!nextLine) continue;
        const gap = nextLine.startTime - line.endTime;
        if (gap > 0 && gap < 5) {
            const lastChar = line.chars[line.chars.length - 1];
            lastChar.endTime += gap;
            line.endTime += gap;
        }
    }

    // 段落检测
    const EXIT_BUF = 2.0;
    const ENTRY_BUF = 2.0;
    const paraEntryBuf = config.indicatorEnabled ? entryBuf : ENTRY_BUF;
    let paraIdx = 0, lineInPara = 0;
    let paraStartTime = lyrics.length > 0 ? lyrics[0].startTime : 0;
    for (let i = 0; i < lyrics.length; i++) {
        if (i > 0 && lyrics[i].startTime - lyrics[i - 1].endTime > paraEntryBuf + EXIT_BUF) {
            paraIdx++; lineInPara = 0; paraStartTime = lyrics[i].startTime;
        }
        lyrics[i].paragraph = paraIdx;
        lyrics[i].lineInParagraph = lineInPara;
        lyrics[i].paraStartTime = paraStartTime;
        lyrics[i].entryTime = lyrics[i].startTime - entryBuf;
        lyrics[i].walkDoneTime = lyrics[i].endTime;
        lineInPara++;
    }

    // 首对行同步
    for (let i = 0; i < lyrics.length; i++) {
        if (lyrics[i].lineInParagraph === 1) {
            lyrics[i].entryTime = lyrics[i].paraStartTime - entryBuf;
        }
    }

    // 段内同行间隙
    for (let i = 0; i < lyrics.length - 2; i++) {
        const cur = lyrics[i], next = lyrics[i + 2];
        if (next.paragraph !== cur.paragraph) continue;
        if (next.entryTime > cur.endTime + EXIT_BUF) {
            cur.walkDoneTime = cur.endTime + EXIT_BUF;
            next.entryTime = cur.walkDoneTime;
        }
    }

    // 走字延长保护（指示灯）
    if (config.indicatorEnabled) {
        const WALK_PROTECT = 1, PROTECT_MIN_MARGIN = 2.5;
        for (let i = 0; i < lyrics.length - 2; i++) {
            const cur = lyrics[i], next = lyrics[i + 2];
            if (next.paragraph !== cur.paragraph) continue;
            const proposed = cur.walkDoneTime + WALK_PROTECT;
            if (next.startTime >= proposed + PROTECT_MIN_MARGIN) {
                cur.walkDoneTime = proposed;
            }
        }
    }

    // 标记段首/尾行
    for (let i = 0; i < lyrics.length; i++) {
        const next = lyrics[i + 1];
        lyrics[i].isLastInParagraph = !next || next.paragraph !== lyrics[i].paragraph;
        lyrics[i].isFirstInParagraph = lyrics[i].lineInParagraph <= 1;
    }

    // 标记段首/尾行完毕，返回结果
    return lyrics;
}