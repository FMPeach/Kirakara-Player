// ==================== 共享配置 ====================

const CONFIG_DEFAULTS = {
    fontSize: 64, 
    letterSpacing: 9,
    fontFamily: "'Microsoft YaHei', sans-serif", 
    fontBold: true,
    rubySize: 26, 
    rubyOffset: 4, 
    rubyLetterSpacing: 5, 
    rubyBold: false, 
    rubyStrokeWidth: 4,
    ruby2Size: 20, 
    ruby2Offset: 4, 
    ruby2LetterSpacing: 4, 
    ruby2Bold: false, 
    ruby2StrokeWidth: 3,
    rubyIsolateEnabled: true,
    colorBefore: '#ffffff', 
    colorAfter: '#a50000',
    strokeColorBefore: '#000000', 
    strokeColorAfter: '#ffffff', 
    strokeWidth: 5,
    line1X: 128, 
    line1Y: 430, 
    line2Right: 128, 
    line2Y: 563, 
    bgColor: '#005500',
    fadeEnabled: true, 
    fadeParagraphOnly: true, 
    fadeDurationMs: 666,
    indicatorEnabled: true, 
    indicatorDuration: 3, 
    indicatorSize: 34, 
    indicatorSpacing: 12,
    indicatorStrokeWidth: 3, 
    indicatorStrokeColor: '#000000', 
    indicatorFillColor: '#ffffff',
    indicatorFadeRatio: 0.0, 
    indicatorOffsetX: 0, 
    indicatorOffsetY: 8,
    // 角色配置：
    // { 
    //   roleName: 
    //   { 
    //     displayName, 
    //     displayColor, 
    //     showLabel, 
    //     labelStrokeColor, 
    //     colorBefore, 
    //     colorAfter, 
    //     strokeColorBefore, 
    //     strokeColorAfter, 
    //     image
    //   }
    //}
    // displayName: 可选外显名称（如 "A"），缺省显示 roleName
    // displayColor: 可选外显标签颜色，缺省用 colorBefore
    // showLabel: 是否在歌词前显示角色名标签
    // labelStrokeColor: 外显标签描边色，缺省用全局 strokeColorBefore
    // image: 可选图片 URL，不为空时渲染图片替代文字
    characterProfiles: {},
    // 角色标签装饰：前缀 / 分隔符 / 后缀（空字符串=不使用）
    roleLabelPrefix: '',
    roleLabelSeparator: '',
    roleLabelSuffix: '',
    songTitle: createDefaultSongTitleConfig(),
};

const STORAGE_KEY = 'karaoke-proto-config';

function legacyLine2BottomToY(config) {
    const fs = Number(config?.fontSize ?? CONFIG_DEFAULTS.fontSize) || CONFIG_DEFAULTS.fontSize;
    const bottom = Number(config?.line2Bottom ?? 80) || 0;
    const lineHeight = Math.round(fs * 1.2);
    return 720 - bottom - lineHeight;
}

function getLine2Y(config) {
    const y = config?.line2Y;
    if (y !== undefined && y !== null && y !== '') return Number(y) || 0;
    return legacyLine2BottomToY(config);
}

function normalizeConfig(rawConfig) {
    const raw = rawConfig || {};
    const config = { ...CONFIG_DEFAULTS, ...raw };
    config.songTitle = normalizeSongTitleConfig(raw.songTitle);
    if (raw.line2Y === undefined && raw.line2Bottom !== undefined) {
        config.line2Y = legacyLine2BottomToY(config);
    }
    delete config.line2Bottom;
    return config;
}

// 过滤当前版本不支持的配置
const SUPPORTED_CONFIG_FIELDS = Object.keys(CONFIG_DEFAULTS);

function stripUnsupportedConfigFields(config) {
    if (!config || typeof config !== 'object') return config;
    for (const k of Object.keys(config)) {
        if (!SUPPORTED_CONFIG_FIELDS.includes(k)) delete config[k];
    }
    return config;
}

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



// 根据 char.roles 解析颜色集（单角色→1组，双角色→2组，无角色→全局默认）
// 返回: [{ colorBefore, colorAfter, strokeColorBefore, strokeColorAfter, strokeWidth, image, displayName, displayColor }]
function resolveRoleColors(roles, config) {
    const profiles = config.characterProfiles || {};
    const defaults = {
        colorBefore: config.colorBefore, colorAfter: config.colorAfter,
        strokeColorBefore: config.strokeColorBefore, strokeColorAfter: config.strokeColorAfter,
        strokeWidth: config.strokeWidth, image: null, displayName: null, displayColor: null,
    };
    if (!roles || roles.length === 0) return [defaults];
    return roles.map(roleName => {
        const p = profiles[roleName];
        if (!p) return { ...defaults, displayName: roleName };
        return {
            colorBefore: p.colorBefore || config.colorBefore,
            colorAfter: p.colorAfter || config.colorAfter,
            strokeColorBefore: p.strokeColorBefore || config.strokeColorBefore,
            strokeColorAfter: p.strokeColorAfter || config.strokeColorAfter,
            strokeWidth: p.strokeWidth || config.strokeWidth,
            image: p.image || null,
            displayName: p.displayName || roleName,
            displayColor: p.displayColor || p.colorBefore || config.colorBefore,
        };
    });
}

