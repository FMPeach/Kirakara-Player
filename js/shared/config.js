// ==================== 共享配置 ====================

const CONFIG_DEFAULTS = {
    fontSize: 64, letterSpacing: 9,
    fontFamily: "'Microsoft YaHei', sans-serif", fontBold: true,
    rubySize: 26, rubyOffset: 4, rubyLetterSpacing: 5, rubyBold: false, rubyStrokeWidth: 4,
    colorBefore: '#ffffff', colorAfter: '#a50000',
    strokeColorBefore: '#000000', strokeColorAfter: '#ffffff', strokeWidth: 5,
    line1X: 128, line1Y: 430, line2Right: 128, line2Bottom: 80, bgColor: '#005500',
    fadeEnabled: true, fadeParagraphOnly: true, fadeDurationMs: 666,
    indicatorEnabled: true, indicatorDuration: 3, indicatorSize: 34, indicatorSpacing: 12,
    indicatorStrokeWidth: 3, indicatorStrokeColor: '#000000', indicatorFillColor: '#ffffff',
    indicatorFadeRatio: 0.0, indicatorOffsetX: 0, indicatorOffsetY: 8,
    bgImageOpacity: 1.0,
};

const STORAGE_KEY = 'karaoke-proto-config';

// 时间窗口常量
const ENTRY_BUF = 2.0;   // 提前入场（秒）
const EXIT_BUF  = 2.0;   // 延后离场（秒）

// 指示灯开启时 → 提前入场时间
function getEntryBuf(config) {
    if (config.indicatorEnabled) {
        const fadeSec = (config.fadeDurationMs || 666) / 1000;
        return fadeSec + 0.5 + (config.indicatorDuration || 4);
    }
    return ENTRY_BUF;
}
