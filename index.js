/*
 * Combo Rotator for SillyTavern
 * 把多个「连接配置文件(Connection Profile)」（每个已含预设+模型）配成组合，
 * 在「扩展」设置面板里按「每 N 轮对话」顺序或随机轮换。
 *
 * 切换时机：每轮 AI 回复完成后计数，达到频率就切换，使下一轮使用新组合。
 * 切换方式：内置 slash 命令  /profile <名字>
 */

const MODULE = 'combo_rotator';

function ctx() {
    return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
        ? SillyTavern.getContext()
        : null;
}

const DEFAULTS = {
    enabled: false,        // 总开关；关闭 = 永不切换
    mode: 'sequential',    // 'sequential' 顺序 | 'random' 随机
    frequency: 1,          // 每 N 轮对话切换一次（>=1）
    suppressRegexToast: true, // 吞掉「预设包含正则，需重载聊天」的提示
    combos: [],            // [{ name, profile }]
    currentIndex: 0,
    roundCounter: 0,
};

let S; // settings 引用

function loadSettings() {
    const c = ctx();
    if (!c) return;
    c.extensionSettings[MODULE] = Object.assign({}, DEFAULTS, c.extensionSettings[MODULE] || {});
    if (!Array.isArray(c.extensionSettings[MODULE].combos)) {
        c.extensionSettings[MODULE].combos = [];
    }
    S = c.extensionSettings[MODULE];
}

function save() {
    const c = ctx();
    if (c) c.saveSettingsDebounced();
}

/* ---------------- 读取连接配置列表（失败则留空，仍可手填） ---------------- */

function getProfileNames() {
    try {
        const c = ctx();
        const cm = c?.extensionSettings?.connectionManager
            || (typeof extension_settings !== 'undefined' ? extension_settings.connectionManager : null);
        const profiles = cm?.profiles;
        if (!Array.isArray(profiles)) return [];
        return profiles.map(p => (typeof p === 'string' ? p : p?.name)).filter(Boolean);
    } catch (e) { return []; }
}

/* ---------------- 应用组合 ---------------- */

async function applyCombo(idx, { announce = true } = {}) {
    const c = ctx();
    if (!c || !S.combos.length) return;
    const combo = S.combos[idx];
    if (!combo || !combo.profile || !combo.profile.trim()) return;
    try {
        await c.executeSlashCommandsWithOptions(`/profile ${combo.profile.trim()}`, { showOutput: false });
        if (announce && c.toastr) {
            c.toastr.info(`已切换到组合：${combo.name || ('#' + (idx + 1))}`, 'Combo Rotator', { timeOut: 1500 });
        }
    } catch (e) {
        console.error('[Combo Rotator] 应用组合失败', e);
        if (c.toastr) c.toastr.error('应用组合失败，请检查连接配置名是否正确', 'Combo Rotator');
    }
    updateStatus();
}

function pickNextIndex() {
    const n = S.combos.length;
    if (n <= 1) return S.currentIndex;
    if (S.mode === 'random') {
        let i;
        do { i = Math.floor(Math.random() * n); } while (i === S.currentIndex);
        return i;
    }
    return (S.currentIndex + 1) % n;
}

/* ---------------- 轮次计数（每轮 = 用户发 + AI回复，AI回复后 +1） ---------------- */

function onAiReply(messageId) {
    const c = ctx();
    if (!c || !S.enabled) return;
    try {
        const msg = c.chat?.[messageId];
        if (msg && (msg.is_user || msg.is_system)) return;
    } catch (e) { /* ignore */ }

    if (S.combos.length < 2) { updateStatus(); return; }
    const freq = Math.max(1, parseInt(S.frequency) || 1);

    S.roundCounter++;
    if (S.roundCounter >= freq) {
        S.roundCounter = 0;
        S.currentIndex = pickNextIndex();
        save();
        applyCombo(S.currentIndex);
    } else {
        save();
        updateStatus();
    }
}

/* ---------------- 吞掉「预设含正则，需重载聊天」的提示 ---------------- */

const REGEX_TOAST_MARKERS = [
    '包含被启用的正则', '使正则生效', '重新加载聊天', '重新加载当前聊天',
    'enabled regex', 'Reload the chat', 'reload the current chat',
];

function installToastFilter() {
    try {
        const t = window.toastr;
        if (!t || t.__crWrapped) return;
        const wrap = (fn) => function (msg, title) {
            try {
                if (S && S.suppressRegexToast) {
                    const hay = `${msg ?? ''} ${title ?? ''}`;
                    if (REGEX_TOAST_MARKERS.some(m => hay.includes(m))) return;
                }
            } catch (e) { /* ignore */ }
            return fn.apply(this, arguments);
        };
        if (typeof t.info === 'function') t.info = wrap(t.info);
        if (typeof t.warning === 'function') t.warning = wrap(t.warning);
        if (typeof t.success === 'function') t.success = wrap(t.success);
        t.__crWrapped = true;
    } catch (e) {
        console.warn('[Combo Rotator] toast 过滤安装失败', e);
    }
}

/* ---------------- UI（嵌入「扩展」设置面板） ---------------- */

function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
}

function escapeAttr(s) {
    return String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function optionList(values, selected, placeholder) {
    const set = Array.isArray(values) ? values.slice() : [];
    if (selected && !set.includes(selected)) set.unshift(selected);
    const ph = `<option value="" ${selected ? '' : 'selected'} disabled hidden>${placeholder}</option>`;
    const opts = set.map(v =>
        `<option value="${escapeAttr(v)}" ${v === selected ? 'selected' : ''}>${escapeAttr(v)}</option>`
    ).join('');
    const manual = `<option value="__manual__">✎ 手动输入…</option>`;
    return ph + opts + manual;
}

function comboRowHtml(combo, i) {
    return `
    <div class="cr-combo-row" data-i="${i}">
        <input class="cr-cname text_pole" placeholder="组合名(如 A版/B版)" value="${escapeAttr(combo.name)}" />
        <select class="cr-cprofile text_pole" title="连接配置（含预设+模型）">${optionList(getProfileNames(), combo.profile, '选连接配置…')}</select>
        <button class="cr-apply menu_button" title="立即应用此组合">▶</button>
        <button class="cr-del menu_button" title="删除">✕</button>
    </div>`;
}

function handleComboSelect(sel, i) {
    if (sel.value === '__manual__') {
        const cur = S.combos[i].profile || '';
        const name = window.prompt('输入连接配置名：', cur);
        if (name && name.trim()) S.combos[i].profile = name.trim();
        save();
        renderCombos();
        return;
    }
    S.combos[i].profile = sel.value;
    save();
}

let $root;

function buildSettings() {
    if (document.getElementById('combo_rotator_settings')) return true;
    const host = document.getElementById('extensions_settings')
        || document.getElementById('extensions_settings2');
    if (!host) return false;

    $root = el(`
    <div id="combo_rotator_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>⇄ Combo Rotator · 预设+连接轮换</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="cr-line">
                    <input type="checkbox" id="cr-enabled" ${S.enabled ? 'checked' : ''}/>
                    <b>启用轮换</b><span class="cr-hint">(关闭=永不切换)</span>
                </label>

                <div class="cr-line">
                    <span>模式：</span>
                    <select id="cr-mode" class="text_pole">
                        <option value="sequential" ${S.mode === 'sequential' ? 'selected' : ''}>顺序轮换</option>
                        <option value="random" ${S.mode === 'random' ? 'selected' : ''}>完全随机</option>
                    </select>
                </div>

                <div class="cr-line">
                    <span>每</span>
                    <input type="number" id="cr-freq" class="text_pole" min="1" step="1" value="${S.frequency}" style="width:54px"/>
                    <span>轮对话切换一次</span>
                </div>

                <label class="cr-line">
                    <input type="checkbox" id="cr-suppress-toast" ${S.suppressRegexToast ? 'checked' : ''}/>
                    <span>隐藏切换时的「正则需重载」提示</span>
                </label>

                <div class="cr-line cr-combos-head">
                    <b>组合列表</b>
                    <span class="cr-hint">每组 = 1 连接配置（含预设+模型）</span>
                </div>
                <div id="cr-combos"></div>
                <button id="cr-add" class="menu_button">+ 添加组合</button>

                <div class="cr-line cr-actions">
                    <button id="cr-applycur" class="menu_button">应用当前组合</button>
                    <button id="cr-resetcnt" class="menu_button">重置计数</button>
                    <button id="cr-refresh" class="menu_button" title="刷新连接配置列表">↻ 刷新选项</button>
                </div>

                <div id="cr-status" class="cr-status"></div>
            </div>
        </div>
    </div>`);
    host.appendChild($root);

    wireSettings();
    renderCombos();
    updateStatus();
    return true;
}

function renderCombos() {
    if (!$root) return;
    const box = $root.querySelector('#cr-combos');
    box.innerHTML = S.combos.map((c, i) => comboRowHtml(c, i)).join('');
    box.querySelectorAll('.cr-combo-row').forEach(row => {
        const i = parseInt(row.dataset.i);
        row.querySelector('.cr-cname').addEventListener('input', e => { S.combos[i].name = e.target.value; save(); updateStatus(); });
        row.querySelector('.cr-cprofile').addEventListener('change', e => handleComboSelect(e.target, i));
        row.querySelector('.cr-apply').addEventListener('click', () => { S.currentIndex = i; S.roundCounter = 0; save(); applyCombo(i); });
        row.querySelector('.cr-del').addEventListener('click', () => {
            S.combos.splice(i, 1);
            if (S.currentIndex >= S.combos.length) S.currentIndex = 0;
            save(); renderCombos(); updateStatus();
        });
    });
}

function refreshOptions() {
    if ($root) renderCombos();
}

function wireSettings() {
    $root.querySelector('#cr-enabled').addEventListener('change', e => {
        S.enabled = e.target.checked; S.roundCounter = 0; save(); updateStatus();
    });
    $root.querySelector('#cr-mode').addEventListener('change', e => { S.mode = e.target.value; save(); });
    $root.querySelector('#cr-suppress-toast').addEventListener('change', e => { S.suppressRegexToast = e.target.checked; save(); });
    $root.querySelector('#cr-freq').addEventListener('input', e => {
        S.frequency = Math.max(1, parseInt(e.target.value) || 1); save(); updateStatus();
    });
    $root.querySelector('#cr-add').addEventListener('click', () => {
        S.combos.push({ name: '', profile: '' });
        save(); renderCombos(); updateStatus();
    });
    $root.querySelector('#cr-applycur').addEventListener('click', () => applyCombo(S.currentIndex));
    $root.querySelector('#cr-resetcnt').addEventListener('click', () => { S.roundCounter = 0; save(); updateStatus(); });
    $root.querySelector('#cr-refresh').addEventListener('click', () => refreshOptions());
}

function updateStatus() {
    if (!$root) return;
    const st = $root.querySelector('#cr-status');
    if (!st) return;
    const cur = S.combos[S.currentIndex];
    const name = cur ? (cur.name || ('#' + (S.currentIndex + 1))) : '（无）';
    const freq = Math.max(1, parseInt(S.frequency) || 1);
    let line = `当前组合：<b>${escapeAttr(name)}</b>`;
    if (S.enabled && S.combos.length >= 2) {
        line += ` ｜ 距下次切换：${Math.max(0, freq - S.roundCounter)} 轮`;
    } else if (!S.enabled) {
        line += ` ｜ <span style="opacity:.7">未启用（永不切换）</span>`;
    } else {
        line += ` ｜ <span style="opacity:.7">需至少 2 个组合</span>`;
    }
    st.innerHTML = line;
}

/* ---------------- 初始化 ---------------- */

function init() {
    const c = ctx();
    if (!c) { setTimeout(init, 500); return; }
    loadSettings();
    installToastFilter();

    // 设置面板可能稍后才挂载，挂不上就重试
    if (!buildSettings()) {
        let tries = 0;
        const timer = setInterval(() => {
            if (buildSettings() || ++tries > 40) clearInterval(timer);
        }, 500);
    }

    const ev = c.eventSource;
    const T = c.eventTypes || c.event_types;
    if (ev && T) {
        ev.on(T.MESSAGE_RECEIVED, onAiReply);
        if (T.CHAT_CHANGED) ev.on(T.CHAT_CHANGED, () => { S.roundCounter = 0; save(); updateStatus(); });
    } else {
        console.warn('[Combo Rotator] 未取到 eventSource / eventTypes，计数功能可能不可用');
    }
    console.log('[Combo Rotator] 已加载');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
