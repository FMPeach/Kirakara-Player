// ==================== 本机字体枚举 ====================
// Local Font Access API —— window.queryLocalFonts()
// 文档：https://developer.mozilla.org/zh-CN/docs/Web/API/Local_Font_Access_API
//
// 可用条件：安全上下文（https / localhost / 127.0.0.1）+ 用户授权（local-fonts 权限）。
// 首次调用需要在用户手势中触发，浏览器会弹出授权框。
// 任何情况下不可用（旧浏览器、非安全上下文、权限被拒、读取异常）都回退到 PRESET_FONTS。
//
// 关于「名字」的三层含义（都来自实测）：
//   1. FontData.family    —— Chrome 给的族名，拉丁字体通常已经是通用名（SimSun / Microsoft YaHei），
//                            CJK 字体有时是本地化名（超研澤細明 / 星颂音乐圆体 常规）。
//   2. FontData.fullName  —— Windows 上是本地化全名（宋体 / 微软雅黑 / 寒蝉全圆体Regular），
//                            列表里就用它来显示「当前语言下的名字」。
//   3. 字体文件 name 表   —— 英文（langID 0x409）族名才是跨语言的通用名；用 blob() 切片读出来，
//                            只有当它在 CSS 里真能解析、且渲染结果与原族名一致时才替换写入配置的值。

const KiraFonts = (() => {
    // ---- 预置字体：API 不可用时的回退值 ----
    const PRESET_FONTS = Object.freeze([
        { value: "'Microsoft YaHei', sans-serif", label: '微软雅黑' },
        { value: "'SimHei', sans-serif", label: '黑体' },
        { value: "'Kaiti', serif", label: '楷体' },
        { value: "'Noto Sans JP', sans-serif", label: 'Noto Sans JP' },
        { value: "'Noto Serif JP', serif", label: 'Noto Serif JP' },
        { value: "'Yu Gothic Medium', sans-serif", label: '游ゴシック' },
        { value: "'Yu Mincho Medium', serif", label: '游明朝' },
        { value: "'MotoyaLMaru W3 Mono', monospace", label: 'モトヤL丸 W3 Mono' },
        { value: "'UD Digi Kyokasho NP-R', sans-serif", label: 'UD Digital 教科书体' },
        { value: "'寒蝉全圆体', sans-serif", label: '寒蝉全圆体' },
        { value: "'小濑字体P JP', sans-serif", label: '小濑字体' },
        { value: "'RiiPopkaku', sans-serif", label: 'りいポップ角' },
        { value: 'system-ui', label: '系统默认' },
    ]);

    // CSS 通用字族：不做引号包裹，也不需要 fallback
    const GENERIC_FAMILIES = Object.freeze([
        'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
        'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
    ]);

    // CJK / 假名 / 谚文 —— 用来判断一个名字是不是「本地化名」
    const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]/;
    // 用于判定的探针：拉丁 / 假名 / 汉字，任一能命中即可
    const PROBES = ['Wg', 'あ', '漢'];
    const FALLBACKS = ['monospace', 'serif', 'sans-serif'];

    // ---------------------------------------------------------------- 字重后缀
    // 与 kirakara-show 的 src/font_request.cpp（照 Chromium font_cache_skia_win.cc 的
    // suffix heuristic 实现）保持完全一致：家族名末尾的字重词会被剥掉，转成数值字重。
    // 注意 Bold 不在表里 —— Chromium 故意不把 Bold 当后缀，得靠真实 face 名匹配。
    const WEIGHT_SUFFIXES = Object.freeze([
        ['Thin', 100], ['ExtraLight', 200], ['UltraLight', 200],
        ['Light', 300], ['Regular', 400], ['Medium', 500],
        ['DemiBold', 600], ['SemiBold', 600], ['ExtraBold', 800],
        ['UltraBold', 800], ['Black', 900], ['Heavy', 900],
    ]);

    // 单个词 -> 后缀规范名（大小写不敏感，必须整体相等）
    function suffixWeight(word) {
        const text = String(word == null ? '' : word).trim().toLowerCase();
        if (!text) return null;
        for (const [name, weight] of WEIGHT_SUFFIXES) {
            if (name.toLowerCase() === text) return { suffix: name, weight };
        }
        return null;
    }

    // 与 C++ parse_font_request 同规则：按最后一个空格切，末词命中后缀表才算显式字重
    function parseFontRequest(name) {
        const text = String(name == null ? '' : name).trim();
        const result = { requestedName: text, familyName: text, baseWeight: 400, hasExplicitWeightSuffix: false };
        const split = text.lastIndexOf(' ');
        if (split < 0) return result;
        const family = text.slice(0, split).trim();
        if (!family) return result;
        const hit = suffixWeight(text.slice(split + 1));
        if (!hit) return result;
        result.familyName = family;
        result.baseWeight = hit.weight;
        result.hasExplicitWeightSuffix = true;
        return result;
    }


    let snapshot = {
        status: typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function' ? 'idle' : 'unsupported',
        families: [],
        message: '',
    };
    let pending = null;
    let collator;
    let knownFamilies = new Set(); // 已枚举到的族名（小写），用于判断英文名是否属于另一个字体

    // ---------------------------------------------------------------- 值解析 / 生成

    // "'Microsoft YaHei', sans-serif" -> ['Microsoft YaHei', 'sans-serif']
    function parseFamilyList(value) {
        const text = String(value == null ? '' : value);
        const names = [];
        let i = 0;
        while (i < text.length) {
            while (i < text.length && /[\s,]/.test(text[i])) i++;
            if (i >= text.length) break;
            let name = '';
            const quote = text[i];
            if (quote === '"' || quote === "'") {
                i++;
                while (i < text.length && text[i] !== quote) {
                    if (text[i] === '\\' && i + 1 < text.length) i++;
                    name += text[i++];
                }
                i++;
            } else {
                while (i < text.length && text[i] !== ',') name += text[i++];
                name = name.trim();
            }
            if (name) names.push(name);
        }
        return names;
    }

    // 取主字族名（用于和本机字体列表比对）
    function parseFamily(value) {
        return parseFamilyList(value)[0] || '';
    }

    // 单个字族名 -> 可直接用于 CSS / canvas 的 font-family 值
    function cssValue(family, fallback) {
        const name = String(family == null ? '' : family).trim();
        const generic = fallback || 'sans-serif';
        if (!name) return generic;
        if (GENERIC_FAMILIES.includes(name.toLowerCase())) return name;
        if (name.includes(',')) return name; // 已经是完整列表，原样返回
        const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return "'" + escaped + "', " + generic;
    }

    // 列表显示用的本地化名：fullName 是本地化名时用它（可去掉尾部字重词），否则用族名
    function localizedName(fullName, family, style) {
        const full = String(fullName == null ? '' : fullName).trim();
        if (!full || full === family) return family;
        if (!CJK_RE.test(full)) return family; // 纯 ASCII 的 fullName 多半是 PS 名或 "Family Regular"，不可靠
        let name = full;
        const styleName = String(style == null ? '' : style).trim().toLowerCase();
        if (styleName && name.toLowerCase().endsWith(styleName)) {
            const trimmed = name.slice(0, name.length - styleName.length).trim();
            if (trimmed && CJK_RE.test(trimmed)) name = trimmed;
        }
        return name || family;
    }

    // ---------------------------------------------------------------- 搜索匹配

    function normalize(text) {
        return String(text == null ? '' : text).toLowerCase().replace(/\s+/g, '');
    }

    // 空格分隔多关键词，全部命中才算匹配
    function matches(text, query) {
        const tokens = String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
        if (!tokens.length) return true;
        const haystack = normalize(text);
        return tokens.every(token => haystack.includes(normalize(token)));
    }

    // ---------------------------------------------------------------- 名字是否真能命中字体
    // 判据：同一个名字分别配 monospace / serif / sans-serif 三个 fallback 渲染，
    // 若三者像素完全一致 → fallback 没被用到 → 这个名字确实命中了一个真实字体。
    // （单看 measureText 宽度不够：中日文字体的全角步进宽度相同，容易误判。）

    let probeCtx = null;
    function getProbeContext() {
        if (probeCtx !== null) return probeCtx;
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 120;
            canvas.height = 56;
            probeCtx = canvas.getContext('2d', { willReadFrequently: true });
        } catch (_) {
            probeCtx = false;
        }
        return probeCtx;
    }

    const resolveCache = new Map();  // name -> boolean
    const imageCache = new Map();    // css -> Uint8ClampedArray

    function probeImage(fontCss) {
        if (imageCache.has(fontCss)) return imageCache.get(fontCss);
        const ctx = getProbeContext();
        if (!ctx) return null;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 120, 56);
        ctx.fillStyle = '#fff';
        ctx.font = fontCss;
        ctx.textBaseline = 'top';
        ctx.fillText(probeImage.text, 6, 8);
        const data = ctx.getImageData(0, 0, 120, 56).data;
        imageCache.set(fontCss, data);
        return data;
    }

    function samePixels(a, b) {
        if (!a || !b) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    // 名字能否作为 font-family 解析到真实字体
    function resolves(name) {
        const key = String(name == null ? '' : name);
        if (!key) return false;
        if (resolveCache.has(key)) return resolveCache.get(key);
        const quoted = '"' + key.replace(/"/g, '\\"') + '"';
        let hit = false;
        for (const probe of PROBES) {
            probeImage.text = probe;
            const base = probeImage('40px ' + quoted + ', ' + FALLBACKS[0]);
            if (!base) continue;
            let stable = true;
            for (let i = 1; i < FALLBACKS.length; i++) {
                if (!samePixels(base, probeImage('40px ' + quoted + ', ' + FALLBACKS[i]))) { stable = false; break; }
            }
            if (stable) { hit = true; break; }
        }
        probeImage.text = PROBES[0];
        resolveCache.set(key, hit);
        return hit;
    }

    // 两个名字是否渲染成同一个字体（字形像素 + 步进宽度双重比对）
    function sameRendering(nameA, nameB) {
        const a = '"' + String(nameA).replace(/"/g, '\\"') + '"';
        const b = '"' + String(nameB).replace(/"/g, '\\"') + '"';
        const ctx = getProbeContext();
        if (!ctx) return false;
        for (const probe of PROBES) {
            probeImage.text = probe;
            if (!samePixels(probeImage('40px ' + a + ', monospace'), probeImage('40px ' + b + ', monospace'))) return false;
        }
        // 新宋体 / 宋体 这类近似字体像素可能一致，但步进宽度不同（全角 vs 半角）
        for (const probe of ['Wg', 'Aq9il', 'WWWW', '漢あA']) {
            probeImage.text = probe;
            probeImage('40px ' + a + ', monospace');
            const wa = ctx.measureText(probe).width;
            probeImage('40px ' + b + ', monospace');
            const wb = ctx.measureText(probe).width;
            if (Math.abs(wa - wb) > 0.5) return false;
        }
        probeImage.text = PROBES[0];
        return true;
    }
    probeImage.text = PROBES[0];

    // ---------------------------------------------------------------- 字体文件里的英文通用名
    // 只读 SFNT 头 + name 表（blob().slice 两次），不整份加载。
    // TTC（.ttc 字体集合）要先跳到第一个字体的表目录。

    const nameCache = new Map(); // family -> Promise<{en, local} | null>

    async function readNameRecords(fontData) {
        if (!fontData || typeof fontData.blob !== 'function') return null;
        const blob = await fontData.blob();
        const header = new DataView(await blob.slice(0, 8192).arrayBuffer());
        let dir = 0;
        const tag = String.fromCharCode(header.getUint8(0), header.getUint8(1), header.getUint8(2), header.getUint8(3));
        if (tag === 'ttcf') dir = header.getUint32(12);
        const numTables = header.getUint16(dir + 4);
        let nameOffset = 0;
        let nameLength = 0;
        for (let i = 0; i < numTables; i++) {
            const p = dir + 12 + i * 16;
            const t = String.fromCharCode(header.getUint8(p), header.getUint8(p + 1), header.getUint8(p + 2), header.getUint8(p + 3));
            if (t === 'name') {
                nameOffset = header.getUint32(p + 8);
                nameLength = header.getUint32(p + 12);
                break;
            }
        }
        if (!nameOffset || !nameLength) return null;

        const buf = new DataView(await blob.slice(nameOffset, nameOffset + nameLength).arrayBuffer());
        const count = buf.getUint16(2);
        const stringOffset = buf.getUint16(4);
        const records = [];
        for (let i = 0; i < count; i++) {
            const r = 6 + i * 12;
            const platformID = buf.getUint16(r);
            const languageID = buf.getUint16(r + 4);
            const nameID = buf.getUint16(r + 6);
            if (nameID !== 1 && nameID !== 16) continue; // 1=族名 16=排版族名
            const length = buf.getUint16(r + 8);
            const offset = buf.getUint16(r + 10);
            if (length > 512) continue;
            let text = '';
            const start = stringOffset + offset;
            if (start + length > buf.byteLength) continue;
            if (platformID === 3 || platformID === 0) {
                for (let j = 0; j < length; j += 2) {
                    const ch = buf.getUint16(start + j);
                    if (ch) text += String.fromCharCode(ch);
                }
            } else if (platformID === 1) {
                for (let j = 0; j < length; j++) text += String.fromCharCode(buf.getUint8(start + j));
            } else {
                continue;
            }
            if (text) records.push({ platformID, languageID, nameID, text: text.trim() });
        }
        if (!records.length) return null;

        const winEnglish = (nameID) => records.find(r => r.platformID === 3 && r.languageID === 0x409 && r.nameID === nameID);
        const anyLatin = (nameID) => records.find(r => r.nameID === nameID && !CJK_RE.test(r.text));
        const en = winEnglish(16) || winEnglish(1) || anyLatin(16) || anyLatin(1);
        return en ? en.text : null;
    }

    function englishFamily(entry) {
        const key = entry.family;
        if (nameCache.has(key)) return nameCache.get(key);
        const job = readNameRecords(entry.base).catch(() => null);
        nameCache.set(key, job);
        return job;
    }

    // ---------------------------------------------------------------- 读取本机字体

    function isSupported() {
        return typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function';
    }

    function getCollator() {
        if (collator !== undefined) return collator;
        try {
            collator = new Intl.Collator(['zh-Hans-CN', 'ja', 'en'], { numeric: true, sensitivity: 'base' });
        } catch (_) {
            collator = null;
        }
        return collator;
    }

    function compareName(a, b) {
        const c = getCollator();
        return c ? c.compare(a, b) : String(a).localeCompare(String(b));
    }

    // FontData[] -> 按字族去重（同族的 Regular/Bold/... 合并成一条，保留各条 FontData 供读 name 表用）
    function toFamilies(fontData) {
        const map = new Map();
        for (const item of fontData || []) {
            const family = String((item && (item.family || item.fullName)) || '').trim();
            if (!family) continue;
            const key = family.toLowerCase();
            let entry = map.get(key);
            if (!entry) {
                entry = { family, entries: [], styles: [], search: '', display: '' };
                map.set(key, entry);
            }
            entry.entries.push(item);
            const style = String(item.style || '').trim();
            if (style && !entry.styles.includes(style)) entry.styles.push(style);
            const postscriptName = String(item.postscriptName || '').trim();
            if (postscriptName) entry.search = entry.search ? entry.search + ' ' + postscriptName : postscriptName;
        }
        const families = [];
        map.forEach(entry => {
            // 优先拿 Regular 那一条去读 name 表 / 做渲染判定
            const base = entry.entries.find(e => /^(regular|normal|book|roman|常规|标准)$/i.test(String(e.style || '').trim()))
                || entry.entries[0];
            const display = localizedName(base && base.fullName, entry.family, base && base.style);
            families.push({
                family: entry.family,
                display: display || entry.family,
                styles: entry.styles,
                baseStyle: String((base && base.style) || '').trim(),
                base,
                entries: entry.entries,
                search: entry.search,
            });
        });
        families.sort((a, b) => compareName(a.family, b.family));
        knownFamilies = new Set(families.map(f => f.family.toLowerCase()));
        return families;
    }

    function setState(status, families, message) {
        snapshot = { status, families: families || [], message: message || '' };
        return snapshot;
    }

    function reasonOf(error) {
        const name = String((error && error.name) || '');
        if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
        if (name === 'NotSupportedError') return 'unsupported';
        return 'error';
    }

    // 读取（带缓存）。返回 Promise<snapshot>，永不 reject。
    // force=true 时忽略缓存重试（权限拒绝后再试一次）。
    function load(options) {
        const force = !!(options && options.force);
        if (!isSupported()) {
            return Promise.resolve(setState('unsupported', [], '当前浏览器不支持读取本机字体，已回退预置字体'));
        }
        if (!force && pending) return pending;
        setState('loading', force ? [] : snapshot.families, '');

        pending = window.queryLocalFonts()
            .then(list => {
                const families = toFamilies(list);
                if (!families.length) return setState('ready', [], '没有读取到本机字体，已回退预置字体');
                return setState('ready', families, '');
            })
            .catch(error => {
                const reason = reasonOf(error);
                if (reason === 'denied') return setState('denied', [], '未获得本机字体访问权限，已回退预置字体');
                if (reason === 'unsupported') return setState('unsupported', [], '当前浏览器不支持读取本机字体，已回退预置字体');
                const detail = error && error.message ? '：' + error.message : '';
                return setState('error', [], '读取本机字体失败' + detail + '，已回退预置字体');
            });
        return pending;
    }

    function getSnapshot() {
        return snapshot;
    }

    // ---------------------------------------------------------------- 写入配置时用的值
    // 优先用 name 表里的英文族名（跨语言通用），但要先验证：
    //   1) 它能在 CSS 里解析到字体；2) 渲染结果与当前族名完全一致（避免被映射到别的字体）。
    // 任一条不满足就退回 Chrome 给的族名。

    const valueCache = new Map();

    async function universalFamily(entry) {
        if (valueCache.has(entry.family)) return valueCache.get(entry.family);
        let chosen = entry.family;
        try {
            const en = await englishFamily(entry);
            // 四道门槛，全过才用英文名替换：
            //   1) 与当前族名不同
            //   2) 不是列表里另一个独立字体族（新宋体 NSimSun 的 name 表里写着 SimSun，替换会串字体）
            //   3) CSS 能解析到字体
            //   4) 渲染结果（字形 + 宽度）与原族名一致
            if (en && en !== entry.family && !knownFamilies.has(en.toLowerCase()) && resolves(en) && sameRendering(en, entry.family)) {
                chosen = en;
            }
        } catch (_) { /* 读 name 表失败就用族名 */ }
        valueCache.set(entry.family, chosen);
        return chosen;
    }

    // 行 -> 写入 config 的 CSS font-family 值（异步：可能要读字体文件）
    async function resolveValue(row, option) {
        if (!row) return '';
        if (option && option.value) return option.value;
        if (row.presetValue) return row.presetValue;
        const family = await universalFamily(row);
        return cssValue(family);
    }

    // ---------------------------------------------------------------- 字重选项
    // 列表里有两类可选：「常规 / 加粗」走原有 fontBold 开关（值不变，只切加粗），
    // 其余字重写成「族名 + 后缀」，Chromium 剥掉后缀转成数值字重，
    // kirakara-show 的 C++ 端（src/font_request.cpp）按同一张表解析，两边一致。
    // 后缀选项要现场验证：能解析、且渲染结果与默认字重不同（否则说明该字体没有这个 face）。

    const weightCache = new Map();

    // 是否值得展开字重列表：非预置、且该字体族确实有多条 style
    function hasWeightCandidates(row) {
        return !!(row && !row.presetValue && row.styles && row.styles.length > 1);
    }

    async function weightOptions(row) {
        if (!hasWeightCandidates(row)) return [];
        if (weightCache.has(row.family)) return weightCache.get(row.family);
        const job = (async () => {
            const baseSuffix = (suffixWeight(row.baseStyle) || {}).suffix;
            const baseWeight = (suffixWeight(row.baseStyle) || {}).weight || 400;
            const universal = await universalFamily(row);
            const plain = cssValue(universal);
            const options = [{ kind: 'base', label: row.baseStyle || 'Regular', bold: false, weight: baseWeight, value: plain }];
            const hasBold = row.styles.some(style => /^bold$/i.test(style));
            if (hasBold) options.push({ kind: 'bold', label: 'Bold', bold: true, weight: 700, value: plain });

            const names = universal === row.family ? [row.family] : [universal, row.family];
            const seen = new Set();
            for (const style of row.styles) {
                const hit = suffixWeight(style);
                if (!hit || hit.suffix === baseSuffix || seen.has(hit.suffix)) continue;
                seen.add(hit.suffix);
                for (const name of names) {
                    const composed = name + ' ' + hit.suffix;
                    if (!resolves(composed)) continue;
                    if (sameRendering(composed, row.family)) continue; // 落回同一字重，没有意义
                    options.push({ kind: 'suffix', suffix: hit.suffix, label: style, weight: hit.weight, bold: false, value: cssValue(composed) });
                    break;
                }
            }
            // 由细到粗排列：ExtraLight → Light → Regular/Normal → Medium → Bold → Heavy
            const rank = { base: 0, suffix: 1, bold: 2 };
            options.sort((a, b) => (a.weight - b.weight) || (rank[a.kind] - rank[b.kind]));
            return options;
        })().catch(() => []);
        weightCache.set(row.family, job);
        return job;
    }

    // 当前值是否就是这一行（用于列表里打勾）
    function rowMatches(row, value) {
        if (!row) return false;
        const wanted = parseFamilyList(value).map(name => normalize(parseFontRequest(name).familyName));
        if (!wanted.length) return false;
        const own = [row.family, row.display].concat(row.aliases || []).filter(Boolean).map(normalize);
        return wanted.some(name => own.includes(name));
    }

    // ---------------------------------------------------------------- 列表分组
    // API 可用且读到了字体 -> 本机字体；否则 -> 预置字体。
    // 返回 { groups: [{ key, label, count, items }], rows: [item] }，rows 是按顺序铺平的列表（键盘导航用）
    function buildGroups(state, query) {
        const groups = [];
        const source = state && state.status === 'ready' && state.families.length ? state.families : null;

        if (source) {
            const items = [];
            for (const font of source) {
                if (!matches(font.family + ' ' + font.display + ' ' + font.search, query)) continue;
                items.push({
                    key: 'local:' + font.family.toLowerCase(),
                    name: font.display,          // 列表里显示的（当前语言下的名字）
                    family: font.family,         // Chrome 给的族名
                    preview: cssValue(font.display || font.family),
                    styles: font.styles,
                    baseStyle: font.baseStyle,
                    base: font.base,
                    entries: font.entries,
                    search: font.search,
                });
            }
            if (items.length) groups.push({ key: 'local', label: '本机字体', count: items.length, items });
        } else {
            const items = [];
            for (const preset of PRESET_FONTS) {
                const family = parseFamily(preset.value);
                if (!matches(family + ' ' + preset.label, query)) continue;
                items.push({
                    key: 'preset:' + preset.value,
                    name: preset.label,
                    family,
                    preview: preset.value,
                    presetValue: preset.value,
                    styles: [],
                });
            }
            if (items.length) {
                groups.push({
                    key: 'preset',
                    label: state && state.status === 'ready' ? '预置字体' : '预置字体（本机字体不可用）',
                    count: items.length,
                    items,
                });
            }
        }

        const rows = [];
        for (const group of groups) {
            for (const item of group.items) {
                item.index = rows.length;
                rows.push(item);
            }
        }
        return { groups, rows };
    }

    return {
        PRESET_FONTS,
        GENERIC_FAMILIES,
        WEIGHT_SUFFIXES,
        isSupported,
        parseFamily,
        parseFamilyList,
        parseFontRequest,
        suffixWeight,
        cssValue,
        localizedName,
        matches,
        matchesValue: rowMatches,
        load,
        getSnapshot,
        buildGroups,
        resolveValue,
        weightOptions,
        hasWeightCandidates,
        resolvesFamily: resolves,
    };
})();

// 便于在控制台/自动化测试里检查
window.KiraFonts = KiraFonts;
