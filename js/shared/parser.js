// js/shared/parser.js
// 歌词解析（@Ruby + 行内注音双模式）
// 从 LRC 原始文本解析为结构化歌词数据
// References: window.parseRubyInline, window.parseTimeToSeconds, window.ENTRY_BUF, window.EXIT_BUF
// Loaded via plain <script> tag — all values attached to window.

function parseLyrics(lrcRaw, entryBuf, config) {
    var ENTRY_BUF = window.ENTRY_BUF || 2.0;
    var EXIT_BUF = window.EXIT_BUF || 2.0;

    if (!lrcRaw.trim()) {
        return [];
    }

    var lines = lrcRaw.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
    // 放宽时间戳：接受 [mm:ss.xx]、[mm:ss:xx] 以及 [mm:ss]（无厘秒）
    var timeRegex = /\[\d+:\d+(?:[:\.]\d+)?\]/g;
    var rubyTimeRegex = /\[(\d+):(\d+)[:\.](\d+)\]/g; // 匹配 ruby 内部时间标签

    // ---- 第一遍：解析 @Ruby 标签 ----
    // 格式: @RubyN=漢字,読[00:00:23]み[,rangeStart,rangeEnd[,...]]
    // rangeStart/rangeEnd 可为空（表示无界），多对 range 表示多处出现
    var rubyMap = new Map(); // key: kanji → [{ reading, rubyChars, ranges: [{start,end}] }]
    lines.forEach(function(line) {
        var rubyMatch = line.match(/^@ruby(\d+)?=/i);
        if (!rubyMatch) return;
        var content = line.substring(rubyMatch[0].length).trim();
        var firstComma = content.indexOf(',');
        if (firstComma === -1) return;
        var kanji = content.substring(0, firstComma).trim();
        var rest = content.substring(firstComma + 1).trim();

        // 按逗号切分：第0段=reading，后续段=范围时间对
        var parts = rest.split(',');
        var readingPart = (parts[0] || '').trim();

        // 提取 ruby 纯文本 + 逐假名计时
        var rubyChars = [];
        var plainReading = '';
        var lastIdx = 0;
        var matchR;
        var localRubyRegex = new RegExp(rubyTimeRegex.source, 'g');
        while ((matchR = localRubyRegex.exec(readingPart)) !== null) {
            var chara = readingPart.slice(lastIdx, matchR.index);
            if (chara) {
                plainReading += chara;
                var prev = rubyChars.length > 0 ? rubyChars[rubyChars.length - 1] : null;
                rubyChars.push({ char: chara, offsetSec: prev ? (prev.nextOffset || prev.offsetSec) : 0 });
            }
            var mins = parseInt(matchR[1], 10);
            var secs = parseInt(matchR[2], 10);
            var ms = parseInt(matchR[3], 10);
            var offsetSec = mins * 60 + secs + ms / 100;
            if (rubyChars.length > 0) rubyChars[rubyChars.length - 1].nextOffset = offsetSec;
            lastIdx = matchR.index + matchR[0].length;
        }
        var remaining = readingPart.slice(lastIdx);
        if (remaining) {
            plainReading += remaining;
            rubyChars.push({
                char: remaining,
                offsetSec: rubyChars.length > 0
                    ? (rubyChars[rubyChars.length - 1].nextOffset || rubyChars[rubyChars.length - 1].offsetSec)
                    : 0
            });
        }
        if (rubyChars.length > 0) delete rubyChars[rubyChars.length - 1].nextOffset;

        // 解析范围对：parts[1..] 每两个为一对 (rangeStart, rangeEnd)
        var ranges = [];
        for (var i = 1; i < parts.length; i += 2) {
            var sRaw = (parts[i] || '').trim();
            var eRaw = (parts[i + 1] || '').trim();
            var startSec = sRaw ? window.parseTimeToSeconds(sRaw) : 0;
            var endSec = eRaw ? window.parseTimeToSeconds(eRaw) : Infinity;
            ranges.push({ start: startSec, end: endSec });
        }
        // 无范围 = 全局适用
        if (ranges.length === 0) ranges.push({ start: 0, end: Infinity });

        var entry = {
            reading: plainReading,
            rubyChars: rubyChars.length > 0 ? rubyChars : null,
            ranges: ranges
        };
        if (!rubyMap.has(kanji)) {
            rubyMap.set(kanji, [entry]);
        } else {
            rubyMap.get(kanji).push(entry);
        }
    });

    // ---- 辅助：从 rubyMap 查找某汉字的注音（按时间范围匹配） ----
    function findRuby(kanji, timeSec) {
        var entries = rubyMap.get(kanji);
        if (!entries || entries.length === 0) return null;
        // 优先匹配时间范围内的 entry
        for (var ei = 0; ei < entries.length; ei++) {
            var e = entries[ei];
            for (var ri = 0; ri < e.ranges.length; ri++) {
                var r = e.ranges[ri];
                if (timeSec >= r.start && timeSec < r.end) return { reading: e.reading, rubyChars: e.rubyChars };
            }
        }
        // 兜底：返回第一个无范围限制的 entry
        for (var ei2 = 0; ei2 < entries.length; ei2++) {
            var e2 = entries[ei2];
            for (var ri2 = 0; ri2 < e2.ranges.length; ri2++) {
                var r2 = e2.ranges[ri2];
                if (r2.start === 0 && r2.end === Infinity) return { reading: e2.reading, rubyChars: e2.rubyChars };
            }
        }
        return null;
    }

    // ---- 第二遍：解析 LRC 逐字行 ----
    var lyrics = [];
    var skippedNoTag = 0, skippedNoBracket = 0, skippedError = 0;
    lines.forEach(function(line) {
        try {
            // 跳过 @ruby 标签行
            if (/^@ruby/i.test(line)) return;
            // 跳过不以 '[' 开头的行（允许行首有不可见字符）
            if (!line.startsWith('[')) { skippedNoBracket++; return; }
            var tags = line.match(timeRegex);
            if (!tags) { skippedNoTag++; return; }

            // 用时间标签切割（保留空段以对齐 tag 索引，处理连续 time tag 停顿）
            var rawSegments = line.split(timeRegex);
            if (rawSegments.every(function(s) { return !s; })) return;

            var chars = [];
            var lastSegHadNextTag = true;
            var tagIdx = 0;
            var started = false; // 首个非空段之后才允许空段消耗 tag
            rawSegments.forEach(function(seg) {
                if (!seg) {
                    if (started) tagIdx++; // 行中连续 tag → 消耗一个 tag 做停顿
                    return;
                }
                started = true;
                var tokens = window.parseRubyInline(seg);
                var segStart = window.parseTimeToSeconds(tags[tagIdx]);
                var hasNextTag = !!tags[tagIdx + 1];
                lastSegHadNextTag = hasNextTag;
                var segEnd = hasNextTag
                    ? window.parseTimeToSeconds(tags[tagIdx + 1])
                    : segStart + 0.5;
                tagIdx++;

                var tokenCount = tokens.length;
                tokens.forEach(function(token, j) {
                    var tStart = segStart + (segEnd - segStart) * (j / tokenCount);
                    var tEnd = segStart + (segEnd - segStart) * ((j + 1) / tokenCount);
                    // 行内注音优先（{漢字|かんじ}），@ruby 稍后统一匹配
                    chars.push({
                        text: token.text,
                        ruby: token.ruby || null,
                        rubySpan: token.ruby ? 1 : 0,
                        startTime: tStart,
                        endTime: tEnd
                    });
                });
            });

            if (chars.length > 0) {
                // ---- 多字词 @ruby 匹配（优先，如 今日→きょう） ----
                for (var ci = 0; ci < chars.length; ci++) {
                    if (chars[ci].ruby) continue;
                    var combined = chars[ci].text;
                    for (var len = 2; len <= 4 && ci + len <= chars.length; len++) {
                        var blocked = false;
                        for (var k = 1; k < len; k++) {
                            if (chars[ci + k].ruby) { blocked = true; break; }
                        }
                        if (blocked) break;
                        combined += chars[ci + len - 1].text;
                        var r = findRuby(combined, chars[ci].startTime);
                        if (r) {
                            chars[ci].ruby = r.reading;
                            chars[ci].rubyChars = r.rubyChars;
                            chars[ci].rubySpan = len;
                            break;
                        }
                    }
                }
                // ---- 单字 @ruby 匹配（兜底） ----
                for (var ci2 = 0; ci2 < chars.length; ci2++) {
                    if (chars[ci2].ruby) continue;
                    var r2 = findRuby(chars[ci2].text, chars[ci2].startTime);
                    if (r2) {
                        chars[ci2].ruby = r2.reading;
                        chars[ci2].rubyChars = r2.rubyChars;
                        chars[ci2].rubySpan = 1;
                    }
                }

                lyrics.push({
                    startTime: chars[0].startTime,
                    endTime: chars[chars.length - 1].endTime,
                    chars: chars,
                    tailAuto: !lastSegHadNextTag // 尾段无显式时间戳
                });
            }
        } catch (e) {
            skippedError++;
            console.warn('[Parse] 解析行出错:', line.substring(0, 60), e.message);
        }
    });

    // 诊断：如果有输入但解析结果为空，输出原因
    if (lyrics.length === 0 && lrcRaw.trim()) {
        console.warn('[Parse] 解析结果为空！原因:',
            '无时间戳行=' + skippedNoTag,
            '无括号行=' + skippedNoBracket,
            '错误行=' + skippedError,
            '总行数=' + lines.length,
            'lrcRaw前100字=' + lrcRaw.substring(0, 100));
    }

    // ---- 行尾时间补全：仅当尾段无显式时间戳时才延至下一句 ----
    for (var i = 0; i < lyrics.length; i++) {
        var line = lyrics[i];
        if (!line.tailAuto) continue; // 有显式尾戳，不补全
        var nextLine = lyrics[i + 1];
        if (!nextLine) continue;
        var gap = nextLine.startTime - line.endTime;
        if (gap > 0 && gap < 5) {
            var lastChar = line.chars[line.chars.length - 1];
            lastChar.endTime += gap;
            line.endTime += gap;
        }
    }

    // ---- 段落检测：行间间隙 > 入场+离场缓冲 → 新段落 ----
    var paraIdx = 0, lineInPara = 0;
    var paraStartTime = lyrics.length > 0 ? lyrics[0].startTime : 0;
    for (var i2 = 0; i2 < lyrics.length; i2++) {
        if (i2 > 0 && lyrics[i2].startTime - lyrics[i2 - 1].endTime > ENTRY_BUF + EXIT_BUF) {
            paraIdx++;
            lineInPara = 0;
            paraStartTime = lyrics[i2].startTime;
        }
        lyrics[i2].paragraph = paraIdx;
        lyrics[i2].lineInParagraph = lineInPara;
        lyrics[i2].paraStartTime = paraStartTime;
        // 默认：进场 = startTime − entryBuf，走完即切（快句）
        lyrics[i2].entryTime = lyrics[i2].startTime - entryBuf;
        lyrics[i2].walkDoneTime = lyrics[i2].endTime;
        lineInPara++;
    }

    // ---- 首对行同步：lineInParagraph 1 与段首同时进场 ----
    for (var i3 = 0; i3 < lyrics.length; i3++) {
        if (lyrics[i3].lineInParagraph === 1) {
            lyrics[i3].entryTime = lyrics[i3].paraStartTime - entryBuf;
        }
    }

    // ---- 段内同行间隙处理：快句秒切，慢句退场缓冲后再补全 ----
    for (var i4 = 0; i4 < lyrics.length - 2; i4++) {
        var cur = lyrics[i4];
        var next = lyrics[i4 + 2]; // 同行（l1→l1 或 l2→l2）
        if (next.paragraph !== cur.paragraph) continue;
        // 如果下一句自然进场晚于当前句退场缓冲结束 → 长间隙
        if (next.entryTime > cur.endTime + EXIT_BUF) {
            // 给当前句完整退场缓冲，下一句紧贴尾巴进场
            cur.walkDoneTime = cur.endTime + EXIT_BUF;
            next.entryTime = cur.walkDoneTime;
        }
        // 否则（短间隙）：保持默认 walkDoneTime=endTime，快切
    }

    // ---- 走字延长保护（仅指示灯开启时生效） ----
    if (config && config.indicatorEnabled) {
        var WALK_PROTECT = 1;
        var PROTECT_MIN_MARGIN = 2.5;
        for (var i5 = 0; i5 < lyrics.length - 2; i5++) {
            var cur2 = lyrics[i5];
            var next2 = lyrics[i5 + 2];
            if (next2.paragraph !== cur2.paragraph) continue;
            var proposed = cur2.walkDoneTime + WALK_PROTECT;
            if (next2.startTime >= proposed + PROTECT_MIN_MARGIN) {
                cur2.walkDoneTime = proposed;
            }
        }
    }

    // ---- 标记每段尾行（淡入淡出用） ----
    for (var i6 = 0; i6 < lyrics.length; i6++) {
        var next3 = lyrics[i6 + 1];
        lyrics[i6].isLastInParagraph = !next3 || next3.paragraph !== lyrics[i6].paragraph;
        lyrics[i6].isFirstInParagraph = lyrics[i6].lineInParagraph <= 1;
    }

    return lyrics;
}

window.parseLyrics = parseLyrics;
