// ==================== LRC 歌词解析（@Ruby + 行内注音双模式） ====================
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

function parseRubyInline(text) {
    if (!text) return [];
    const result = [];
    const rubyPattern = /\{([^|]+)\|([^}]*)\}/g;
    let lastIndex = 0;
    let match;
    while ((match = rubyPattern.exec(text)) !== null) {
        const before = text.slice(lastIndex, match.index);
        if (before) { for (const ch of before) result.push({ text: ch, ruby: null }); }
        const baseText = match[1] || '';
        const rubyText = match[2] || null;
        result.push({ text: baseText, ruby: rubyText });
        lastIndex = match.index + match[0].length;
    }
    const after = text.slice(lastIndex);
    if (after) { for (const ch of after) result.push({ text: ch, ruby: null }); }
    return result;
}

function parseLyrics(lrcRaw, entryBuf, config) {
    if (!lrcRaw.trim()) { return []; }
    const lines = lrcRaw.split('\n').map(l => l.trim()).filter(l => l);
    const timeRegex = /\[\d+:\d+(?:[:\.]\d+)?\]/g;
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

    // ---- 第二遍：解析 LRC 逐字行 ----
    const lyrics = [];
    lines.forEach(line => {
        try {
            if (/^@ruby/i.test(line)) return;
            if (!line.startsWith('[')) return;
            const tags = line.match(timeRegex);
            if (!tags) return;

            const rawSegments = line.split(timeRegex);
            if (rawSegments.every(s => !s)) return;

            const chars = [];
            let lastSegHadNextTag = true;
            let tagIdx = 0;
            let started = false;
            rawSegments.forEach((seg) => {
                if (!seg) { if (started) tagIdx++; return; }
                started = true;
                const tokens = parseRubyInline(seg);
                const segStart = parseTimeToSeconds(tags[tagIdx]);
                const hasNextTag = !!tags[tagIdx + 1];
                lastSegHadNextTag = hasNextTag;
                const segEnd = hasNextTag ? parseTimeToSeconds(tags[tagIdx + 1]) : segStart + 0.5;
                tagIdx++;

                const tokenCount = tokens.length;
                tokens.forEach((token, j) => {
                    const tStart = segStart + (segEnd - segStart) * (j / tokenCount);
                    const tEnd = segStart + (segEnd - segStart) * ((j + 1) / tokenCount);
                    chars.push({
                        text: token.text, ruby: token.ruby || null,
                        rubySpan: token.ruby ? 1 : 0,
                        startTime: tStart, endTime: tEnd,
                    });
                });
            });

            if (chars.length > 0) {
                // 多字词 @ruby 匹配
                for (let ci = 0; ci < chars.length; ci++) {
                    if (chars[ci].ruby) continue;
                    let combined = chars[ci].text;
                    for (let len = 2; len <= 4 && ci + len <= chars.length; len++) {
                        let blocked = false;
                        for (let k = 1; k < len; k++) { if (chars[ci + k].ruby) { blocked = true; break; } }
                        if (blocked) break;
                        combined += chars[ci + len - 1].text;
                        const r = findRuby(combined, chars[ci].startTime);
                        if (r) { chars[ci].ruby = r.reading; chars[ci].rubyChars = r.rubyChars; chars[ci].rubySpan = len; break; }
                    }
                }
                // 单字 @ruby 匹配
                for (let ci = 0; ci < chars.length; ci++) {
                    if (chars[ci].ruby) continue;
                    const r = findRuby(chars[ci].text, chars[ci].startTime);
                    if (r) { chars[ci].ruby = r.reading; chars[ci].rubyChars = r.rubyChars; chars[ci].rubySpan = 1; }
                }

                lyrics.push({
                    startTime: chars[0].startTime,
                    endTime: chars[chars.length - 1].endTime,
                    chars,
                    tailAuto: !lastSegHadNextTag,
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
    let paraIdx = 0, lineInPara = 0;
    let paraStartTime = lyrics.length > 0 ? lyrics[0].startTime : 0;
    for (let i = 0; i < lyrics.length; i++) {
        if (i > 0 && lyrics[i].startTime - lyrics[i - 1].endTime > ENTRY_BUF + EXIT_BUF) {
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