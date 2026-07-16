// ==================== 歌曲标题共享模型与时间轴 ====================

const SONG_TITLE_ALIGNS = Object.freeze(['left', 'center-left', 'center', 'center-right', 'right']);

const SONG_TITLE_STYLE_DEFAULTS = Object.freeze({
    fontFamily: "'Microsoft YaHei', sans-serif",
    fontSize: 72,
    fontBold: true,
    letterSpacing: 4,
    lineSpacing: 0,
    x: 640,
    y: 170,
    align: 'center',
    color: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: 4,
});

const SONG_TITLE_INFO_STYLE_DEFAULTS = Object.freeze({
    fontFamily: "'Microsoft YaHei', sans-serif",
    fontSize: 32,
    fontBold: false,
    letterSpacing: 2,
    lineSpacing: 12,
    x: 640,
    y: 340,
    align: 'center',
    color: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: 2,
});

function createSongTitleRow() {
    return {
        before: '',
        separator: '',
        after: '',
    };
}

function createSongTitleInfoGroup(index) {
    const position = Math.max(1, Number(index) || 1);
    return {
        kind: 'info',
        name: position === 1 ? '信息' : `信息 ${position}`,
        rows: [createSongTitleRow()],
        style: {
            ...SONG_TITLE_INFO_STYLE_DEFAULTS,
            y: SONG_TITLE_INFO_STYLE_DEFAULTS.y + (position - 1) * 120,
        },
    };
}

function createDefaultSongTitleConfig() {
    return {
        enabled: false,
        durationSec: 3,
        textFade: true,
        prelude: {
            enabled: false,
            backgroundImageName: '',
            fadeEnabled: false,
            fadeDurationMs: 666,
        },
        groups: [
            {
                kind: 'title',
                name: '歌名',
                value: '',
                style: { ...SONG_TITLE_STYLE_DEFAULTS },
            },
            createSongTitleInfoGroup(1),
        ],
    };
}

function _titleFiniteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function _titleText(value, fallback) {
    return typeof value === 'string' ? value : fallback;
}

function _normalizeTitleTextFade(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value && typeof value === 'object') {
        return typeof value.enabled === 'boolean' ? value.enabled : true;
    }
    return fallback;
}

function _normalizeTitleStyle(rawStyle, defaults) {
    const raw = rawStyle && typeof rawStyle === 'object' ? rawStyle : {};
    return {
        fontFamily: _titleText(raw.fontFamily, defaults.fontFamily) || defaults.fontFamily,
        fontSize: Math.max(1, _titleFiniteNumber(raw.fontSize, defaults.fontSize)),
        fontBold: raw.fontBold === undefined ? defaults.fontBold : !!raw.fontBold,
        letterSpacing: _titleFiniteNumber(raw.letterSpacing, defaults.letterSpacing),
        lineSpacing: _titleFiniteNumber(raw.lineSpacing, defaults.lineSpacing),
        x: _titleFiniteNumber(raw.x, defaults.x),
        y: _titleFiniteNumber(raw.y, defaults.y),
        align: SONG_TITLE_ALIGNS.includes(raw.align) ? raw.align : defaults.align,
        color: _titleText(raw.color, defaults.color) || defaults.color,
        strokeColor: _titleText(raw.strokeColor, defaults.strokeColor) || defaults.strokeColor,
        strokeWidth: Math.max(0, _titleFiniteNumber(raw.strokeWidth, defaults.strokeWidth)),
    };
}

function _normalizeTitleRows(rawRows, legacyValue) {
    let sourceRows = Array.isArray(rawRows) ? rawRows.filter(row => row && typeof row === 'object') : [];
    if (sourceRows.length === 0 && typeof legacyValue === 'string') {
        sourceRows = [{ before: legacyValue }];
    }
    if (sourceRows.length === 0) sourceRows = [{}];
    return sourceRows.map(row => ({
        before: _titleText(row.before, ''),
        separator: _titleText(row.separator, ''),
        after: _titleText(row.after, ''),
    }));
}

function normalizeSongTitleConfig(rawConfig) {
    const defaults = createDefaultSongTitleConfig();
    const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    const rawPrelude = raw.prelude && typeof raw.prelude === 'object' ? raw.prelude : {};
    const rawTextFade = raw.textFade === undefined ? raw.textFadeEnabled : raw.textFade;
    const durationValue = _titleFiniteNumber(raw.durationSec, defaults.durationSec);
    const rawGroups = Array.isArray(raw.groups) ? raw.groups.filter(group => group && typeof group === 'object') : [];
    const titleIndex = rawGroups.findIndex(group => group.kind === 'title' || group.id === 'song-title');
    const rawTitle = titleIndex >= 0 ? rawGroups[titleIndex] : {};
    const rawTitleRows = Array.isArray(rawTitle.rows) ? _normalizeTitleRows(rawTitle.rows) : [];
    const firstTitleRow = rawTitleRows[0];
    const legacyRowsValue = firstTitleRow
        ? `${firstTitleRow.before}${firstTitleRow.separator}${firstTitleRow.after}`
        : '';

    const titleGroup = {
        kind: 'title',
        name: '歌名',
        value: _titleText(rawTitle.value, legacyRowsValue),
        style: _normalizeTitleStyle(rawTitle.style, SONG_TITLE_STYLE_DEFAULTS),
    };

    const infoGroups = [];
    for (let i = 0; i < rawGroups.length; i++) {
        if (i === titleIndex) continue;
        const source = rawGroups[i];
        infoGroups.push({
            kind: 'info',
            name: _titleText(source.name, `信息 ${infoGroups.length + 1}`),
            rows: _normalizeTitleRows(source.rows, source.value),
            style: _normalizeTitleStyle(source.style, {
                ...SONG_TITLE_INFO_STYLE_DEFAULTS,
                y: SONG_TITLE_INFO_STYLE_DEFAULTS.y + infoGroups.length * 120,
            }),
        });
    }

    if (infoGroups.length === 0) {
        infoGroups.push(createSongTitleInfoGroup(1));
    }

    return {
        enabled: raw.enabled === undefined ? defaults.enabled : !!raw.enabled,
        durationSec: Math.min(10, Math.max(3, durationValue)),
        textFade: _normalizeTitleTextFade(rawTextFade, defaults.textFade),
        prelude: {
            // Temporarily disabled until the C++ engine matches media timing.
            // enabled: rawPrelude.enabled === undefined ? defaults.prelude.enabled : !!rawPrelude.enabled,
            enabled: false,
            backgroundImageName: _titleText(rawPrelude.backgroundImageName, ''),
            fadeEnabled: rawPrelude.fadeEnabled === undefined ? defaults.prelude.fadeEnabled : !!rawPrelude.fadeEnabled,
            fadeDurationMs: Math.max(0, _titleFiniteNumber(rawPrelude.fadeDurationMs, defaults.prelude.fadeDurationMs)),
        },
        groups: [titleGroup, ...infoGroups],
    };
}

function composeTitleGroupLines(group) {
    if (!group) return [];
    if (typeof group.value === 'string') {
        return group.value !== '' ? [group.value] : [];
    }
    const rows = Array.isArray(group.rows) ? group.rows : [];
    return rows
        .map(row => `${row?.before || ''}${row?.separator || ''}${row?.after || ''}`)
        .filter(text => text !== '');
}

function resolveSongTitleLayout(songTitle) {
    const groups = Array.isArray(songTitle?.groups) ? songTitle.groups : [];
    return groups.map((group, index) => ({
        index,
        kind: group.kind,
        name: group.name,
        lines: composeTitleGroupLines(group),
        style: group.style,
    })).filter(group => group.lines.length > 0);
}

function getSongTitleLineStartX(align, anchorX, lineWidth, paragraphWidth) {
    const x = _titleFiniteNumber(anchorX, 0);
    const width = Math.max(0, _titleFiniteNumber(lineWidth, 0));
    const blockWidth = Math.max(width, _titleFiniteNumber(paragraphWidth, width));

    if (align === 'center-left') return x - blockWidth / 2;
    if (align === 'center-right') return x + blockWidth / 2 - width;
    if (align === 'center') return x - width / 2;
    if (align === 'right') return x - width;
    return x;
}

function getSongTitleTimeline(songTitle) {
    const enabled = !!songTitle?.enabled;
    const duration = Math.min(10, Math.max(3, _titleFiniteNumber(songTitle?.durationSec, 3)));
    const prepend = enabled && !!songTitle?.prelude?.enabled ? duration : 0;
    const titleStart = -prepend;
    return {
        enabled,
        duration,
        prepend,
        timelineStart: -prepend,
        titleStart,
        titleEnd: titleStart + duration,
    };
}

function getSongTitlePrependDuration(songTitle) {
    return getSongTitleTimeline(songTitle).prepend;
}

function isSongTitleVisible(projectTime, songTitle) {
    const timeline = getSongTitleTimeline(songTitle);
    return timeline.enabled && projectTime >= timeline.titleStart && projectTime < timeline.titleEnd;
}

function getSongTitleTextOpacity(projectTime, songTitle, config) {
    const timeline = getSongTitleTimeline(songTitle);
    if (!timeline.enabled || projectTime < timeline.titleStart || projectTime >= timeline.titleEnd) return 0;
    if (songTitle?.textFade === false) return 1;

    const configuredMs = _titleFiniteNumber(config?.fadeDurationMs, 666);
    const fadeSec = Math.min(Math.max(0, configuredMs) / 1000, timeline.duration / 2);
    if (fadeSec <= 0) return 1;

    const fadeIn = Math.max(0, Math.min(1, (projectTime - timeline.titleStart) / fadeSec));
    const fadeOut = Math.max(0, Math.min(1, (timeline.titleEnd - projectTime) / fadeSec));
    return Math.min(fadeIn, fadeOut);
}

function getPreludeBackgroundState(projectTime, songTitle) {
    const timeline = getSongTitleTimeline(songTitle);
    const visible = timeline.prepend > 0 && projectTime >= timeline.titleStart && projectTime < timeline.titleEnd;
    if (!visible) return { visible: false, imageAlpha: 0, layerAlpha: 0 };
    if (!songTitle?.prelude?.fadeEnabled) return { visible: true, imageAlpha: 1, layerAlpha: 1 };

    const fadeMs = Math.max(0, _titleFiniteNumber(songTitle.prelude.fadeDurationMs, 666));
    const fadeSec = Math.min(fadeMs / 1000, timeline.duration / 2);
    if (fadeSec <= 0) return { visible: true, imageAlpha: 1, layerAlpha: 1 };

    return {
        visible: true,
        imageAlpha: Math.max(0, Math.min(1, (projectTime - timeline.titleStart) / fadeSec)),
        layerAlpha: Math.max(0, Math.min(1, (timeline.titleEnd - projectTime) / fadeSec)),
    };
}

if (typeof window !== 'undefined') {
    Object.assign(window, {
        SONG_TITLE_STYLE_DEFAULTS,
        SONG_TITLE_INFO_STYLE_DEFAULTS,
        SONG_TITLE_ALIGNS,
        createSongTitleRow,
        createSongTitleInfoGroup,
        createDefaultSongTitleConfig,
        normalizeSongTitleConfig,
        composeTitleGroupLines,
        resolveSongTitleLayout,
        getSongTitleLineStartX,
        getSongTitleTimeline,
        getSongTitlePrependDuration,
        isSongTitleVisible,
        getSongTitleTextOpacity,
        getPreludeBackgroundState,
    });
}
