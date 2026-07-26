// js/shared/utils.js
// Shared utility functions for Kirakara Player
// Loaded via plain <script> tag — all values attached to window.

// 解析行内注音语法 {汉字|假名}
// 例如 "{好|す}き{漢字|かんじ}を" →
//   [{text:"好", ruby:"す"}, {text:"き", ruby:null}, {text:"漢字", ruby:"かんじ"}, {text:"を", ruby:null}]
function parseRubyInline(text) {
    if (!text) return [];
    var result = [];
    var rubyPattern = /\{([^|]+)\|([^}]*)\}/g;
    var lastIndex = 0;
    var match;
    while ((match = rubyPattern.exec(text)) !== null) {
        // match 前的纯文本
        var before = text.slice(lastIndex, match.index);
        if (before) {
            for (var bi = 0; bi < before.length; bi++) {
                result.push({ text: before[bi], ruby: null });
            }
        }
        // {汉字|假名}
        var baseText = match[1] || '';
        var rubyText = match[2] || null;
        result.push({ text: baseText, ruby: rubyText });
        lastIndex = match.index + match[0].length;
    }
    // 剩余纯文本
    var after = text.slice(lastIndex);
    if (after) {
        for (var ai = 0; ai < after.length; ai++) {
            result.push({ text: after[ai], ruby: null });
        }
    }
    return result;
}

function parseTimeToSeconds(tag) {
    if (!tag) return 0;
    var clean = tag.replace(/[\[\]]/g, '');
    var parts = clean.split(/[:\.]/);
    if (parts.length === 2) {
        // [mm:ss] 格式：分+秒（无厘秒）
        return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    } else if (parts.length >= 3) {
        // [mm:ss.xx] 或 [mm:ss:xx] 格式
        return parseInt(parts[0]) * 60 + parseInt(parts[1]) + parseFloat('0.' + parts[2]);
    }
    return 0;
}

// --- 混合测量：Canvas 字形墨迹 + DOM 总宽（含 letterSpacing） ---
var glyphCache = {};

// Canvas 测量字形 ink 边界（不含 letterSpacing）
var measureGlyphInk = function(text, fontStr) {
    var key = 'ink|' + text + '|' + fontStr;
    if (glyphCache[key]) return glyphCache[key];
    try {
        var c = document.createElement('canvas');
        var ctx = c.getContext('2d');
        ctx.font = fontStr;
        var m = ctx.measureText(text);
        var left = m.actualBoundingBoxLeft || 0;
        var right = m.actualBoundingBoxRight || m.width;
        return (glyphCache[key] = { left: left, right: right, emWidth: m.width });
    } catch (e) {
        return { left: 0, right: 0, emWidth: 0 };
    }
};

// DOM 测量渲染总宽（含 letterSpacing），用于百分比映射
var measureTotalWidth = function(text, fontSize, fontFamily, letterSpacing, fontWeight) {
    var key = 'dom|' + text + '|' + fontSize + '|' + fontFamily + '|' + letterSpacing + '|' + fontWeight;
    if (glyphCache[key]) return glyphCache[key];
    try {
        var span = document.createElement('span');
        span.textContent = text;
        span.style.position = 'fixed';
        span.style.left = '-9999px';
        span.style.fontSize = fontSize + 'px';
        span.style.fontFamily = fontFamily;
        span.style.letterSpacing = letterSpacing + 'px';
        span.style.fontWeight = fontWeight || 'normal';
        span.style.whiteSpace = 'pre';
        document.body.appendChild(span);
        var w = span.scrollWidth;
        document.body.removeChild(span);
        return (glyphCache[key] = w);
    } catch (e) {
        return fontSize;
    }
};

var strokeCache = {};
var genStroke = function(color, width) {
    if (width <= 0 || !color) return 'none';
    var key = color + '_' + width;
    if (strokeCache[key]) return strokeCache[key];
    var parts = [];
    var steps = 32;
    for (var r = 1; r <= width; r += 0.5) {
        for (var t = 0; t < 360; t += 360 / steps) {
            var rad = t * Math.PI / 180;
            parts.push((r * Math.cos(rad)).toFixed(2) + 'px ' + (r * Math.sin(rad)).toFixed(2) + 'px 0px ' + color);
        }
    }
    return (strokeCache[key] = parts.join(','));
};

// Expose to global scope
window.parseRubyInline = parseRubyInline;
window.parseTimeToSeconds = parseTimeToSeconds;
window.glyphCache = glyphCache;
window.measureGlyphInk = measureGlyphInk;
window.measureTotalWidth = measureTotalWidth;
window.strokeCache = strokeCache;
window.genStroke = genStroke;
