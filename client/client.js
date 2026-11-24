// Settings page on this bundle's Plugins screen: Step order, on/off, timeouts, backend options,
// API keys, and Key Check. The Host half is lib/management.js; keys never come back to the page.
window.__ModuleLoader__.load({
  id: 'dsh-web-fetch-chain',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const STEP_NAMES = { http: 'Http', scrapedo: 'Scrape.do', scrapfly: 'Scrapfly', firecrawl: 'Firecrawl' };
    const PAID = ['scrapedo', 'scrapfly', 'firecrawl'];
    const OPTIONS = {
      scrapedo: [['scrapedoRender', 'optScrapedoRender'], ['scrapedoSuper', 'optScrapedoSuper']],
      scrapfly: [['scrapflyRenderJs', 'optScrapflyRenderJs'], ['scrapflyAsp', 'optScrapflyAsp']],
      firecrawl: [['firecrawlOnlyMainContent', 'optFirecrawlOnlyMainContent']],
    };
    const BUDGET_MARGIN_S = 5;
    const NOTICE_MS = 5000;

    const DICT = {
      en: {
        summary: 'Step order, timeouts, options, and API keys for the Fetch chain.',
        title: 'Fetch chain settings',
        intro: 'web_fetch tries the enabled Steps from top to bottom until one succeeds. Choose "Fetch chain" under Settings > Web search and fetch > Web fetch provider.',
        loading: 'Loading…',
        refresh: 'Refresh',
        enabled: 'On',
        moveUp: 'Move {step} up',
        moveDown: 'Move {step} down',
        timeout: 'Timeout',
        seconds: 's',
        optScrapedoRender: 'Render JavaScript (render, more credits)',
        optScrapedoSuper: 'Residential and mobile proxies (super, more credits)',
        optScrapflyRenderJs: 'Render JavaScript (render_js, more credits)',
        optScrapflyAsp: 'Anti-bot bypass (asp, more credits)',
        optFirecrawlOnlyMainContent: 'Main content only (onlyMainContent)',
        apiKey: 'API key',
        keySet: 'Configured',
        keyUnset: 'Not configured',
        source_file: 'DSH credentials file',
        source_env: 'environment variable',
        'source_project-env': 'project .env',
        'source_user-env': '~/.dsh/.env',
        skipped: 'No API key, so the Chain skips this Step.',
        keyPlaceholder: 'Enter a new API key',
        keyPlaceholderSet: 'Enter a key to replace it',
        saveKey: 'Save key',
        deleteKey: 'Delete',
        test: 'Test',
        testing: 'Testing…',
        envNote: 'A key saved here goes to the credentials file and takes precedence.',
        raise: 'Raise the web_fetch time limit to the Chain Budget in new conversations',
        budget: 'Chain Budget: {s} s (enabled Step timeouts + {m} s)',
        save: 'Save',
        saving: 'Saving…',
        revert: 'Revert',
        saveNote: 'Saving restarts the plugin; the new web_fetch limit applies to conversations started afterwards.',
        readOnly: 'This profile cannot save configuration, so these settings are read-only.',
        keysReadOnly: 'No credential store is available, so API keys cannot be edited here.',
        saved: 'Settings saved.',
        keySaved: '{step} API key saved.',
        keyDeleted: '{step} API key deleted.',
        confirmDelete: 'Delete the {step} API key from the DSH credentials file?',
        checkOk: '{step}: valid key.',
        'check_invalid-key': '{step}: invalid key ({status}).',
        check_inactive: '{step}: invalid key or inactive account.',
        'check_http-status': '{step}: the service answered HTTP {status}.',
        'check_bad-response': '{step}: unexpected response from the service.',
        check_timeout: '{step}: the service did not answer in time.',
        check_network: '{step}: connection failed ({message}).',
        'check_no-key': '{step}: no API key to test.',
        timeoutRange: 'Timeouts must be whole seconds from 1 to 300.',
        requestFailed: 'Request failed.',
        dismiss: 'Dismiss',
      },
      ko: {
        summary: 'Fetch chain의 단계 순서, 타임아웃, 옵션, API 키를 설정합니다.',
        title: 'Fetch chain 설정',
        intro: 'web_fetch는 켜진 단계를 위에서부터 차례로 시도해 성공하면 멈춥니다. Settings > Web search and fetch > Web fetch provider에서 "Fetch chain"을 골라야 쓰입니다.',
        loading: '불러오는 중…',
        refresh: '새로고침',
        enabled: '사용',
        moveUp: '{step} 위로',
        moveDown: '{step} 아래로',
        timeout: '타임아웃',
        seconds: '초',
        optScrapedoRender: 'JavaScript 렌더링 (render, 크레딧 추가)',
        optScrapedoSuper: 'Residential·모바일 프록시 (super, 크레딧 추가)',
        optScrapflyRenderJs: 'JavaScript 렌더링 (render_js, 크레딧 추가)',
        optScrapflyAsp: 'Anti-bot 우회 (asp, 크레딧 추가)',
        optFirecrawlOnlyMainContent: '본문만 가져오기 (onlyMainContent)',
        apiKey: 'API 키',
        keySet: '설정됨',
        keyUnset: '설정 안 됨',
        source_file: 'DSH credentials 파일',
        source_env: '환경 변수',
        'source_project-env': '프로젝트 .env',
        'source_user-env': '~/.dsh/.env',
        skipped: 'API 키가 없어 이 단계는 건너뜁니다.',
        keyPlaceholder: '새 API 키 입력',
        keyPlaceholderSet: '바꿀 키 입력',
        saveKey: '키 저장',
        deleteKey: '삭제',
        test: '테스트',
        testing: '확인 중…',
        envNote: '여기서 저장한 키는 credentials 파일에 들어가며 우선 적용됩니다.',
        raise: '새 대화에서 web_fetch 제한 시간을 체인 예산으로 늘리기',
        budget: '체인 예산: {s}초 (켜진 단계 타임아웃 합 + {m}초)',
        save: '저장',
        saving: '저장 중…',
        revert: '되돌리기',
        saveNote: '저장하면 플러그인이 재시작되고, 바뀐 web_fetch 제한 시간은 그 뒤 새로 시작한 대화부터 적용됩니다.',
        readOnly: '이 프로필은 설정을 저장할 수 없어 읽기 전용으로 표시합니다.',
        keysReadOnly: 'credential 저장소가 없어 여기서 API 키를 편집할 수 없습니다.',
        saved: '설정을 저장했습니다.',
        keySaved: '{step} API 키를 저장했습니다.',
        keyDeleted: '{step} API 키를 삭제했습니다.',
        confirmDelete: 'DSH credentials 파일에서 {step} API 키를 삭제할까요?',
        checkOk: '{step}: 유효한 키입니다.',
        'check_invalid-key': '{step}: 유효하지 않은 키입니다 ({status}).',
        check_inactive: '{step}: 유효하지 않은 키이거나 비활성 계정입니다.',
        'check_http-status': '{step}: 서비스가 HTTP {status}로 응답했습니다.',
        'check_bad-response': '{step}: 서비스 응답을 해석할 수 없습니다.',
        check_timeout: '{step}: 서비스가 제때 응답하지 않았습니다.',
        check_network: '{step}: 연결에 실패했습니다 ({message}).',
        'check_no-key': '{step}: 테스트할 API 키가 없습니다.',
        timeoutRange: '타임아웃은 1–300초 사이의 정수여야 합니다.',
        requestFailed: '요청에 실패했습니다.',
        dismiss: '닫기',
      },
      zh: {
        summary: '设置 Fetch chain 的步骤顺序、超时、选项和 API 密钥。',
        title: 'Fetch chain 设置',
        intro: 'web_fetch 从上到下依次尝试已启用的步骤，直到成功。需在 Settings > Web search and fetch > Web fetch provider 中选择“Fetch chain”。',
        loading: '加载中…',
        refresh: '刷新',
        enabled: '启用',
        moveUp: '上移 {step}',
        moveDown: '下移 {step}',
        timeout: '超时',
        seconds: '秒',
        optScrapedoRender: '渲染 JavaScript（render，额外消耗额度）',
        optScrapedoSuper: '住宅和移动代理（super，额外消耗额度）',
        optScrapflyRenderJs: '渲染 JavaScript（render_js，额外消耗额度）',
        optScrapflyAsp: '反爬虫绕过（asp，额外消耗额度）',
        optFirecrawlOnlyMainContent: '仅正文（onlyMainContent）',
        apiKey: 'API 密钥',
        keySet: '已配置',
        keyUnset: '未配置',
        source_file: 'DSH 凭据文件',
        source_env: '环境变量',
        'source_project-env': '项目 .env',
        'source_user-env': '~/.dsh/.env',
        skipped: '没有 API 密钥，链会跳过此步骤。',
        keyPlaceholder: '输入新的 API 密钥',
        keyPlaceholderSet: '输入密钥以替换',
        saveKey: '保存密钥',
        deleteKey: '删除',
        test: '测试',
        testing: '检查中…',
        envNote: '在此保存的密钥写入凭据文件并优先使用。',
        raise: '在新对话中把 web_fetch 时间上限提高到链预算',
        budget: '链预算：{s} 秒（已启用步骤超时之和 + {m} 秒）',
        save: '保存',
        saving: '保存中…',
        revert: '还原',
        saveNote: '保存后插件会重启，新的 web_fetch 上限从之后新开的对话开始生效。',
        readOnly: '此配置无法保存设置，以只读方式显示。',
        keysReadOnly: '没有可用的凭据存储，无法在此编辑 API 密钥。',
        saved: '设置已保存。',
        keySaved: '已保存 {step} 的 API 密钥。',
        keyDeleted: '已删除 {step} 的 API 密钥。',
        confirmDelete: '要从 DSH 凭据文件中删除 {step} 的 API 密钥吗？',
        checkOk: '{step}：密钥有效。',
        'check_invalid-key': '{step}：密钥无效（{status}）。',
        check_inactive: '{step}：密钥无效或账户未激活。',
        'check_http-status': '{step}：服务返回 HTTP {status}。',
        'check_bad-response': '{step}：服务响应无法解析。',
        check_timeout: '{step}：服务未及时响应。',
        check_network: '{step}：连接失败（{message}）。',
        'check_no-key': '{step}：没有可测试的 API 密钥。',
        timeoutRange: '超时必须是 1 到 300 之间的整数秒。',
        requestFailed: '请求失败。',
        dismiss: '关闭',
      },
    };

    function fallbackLang() {
      let lang = '';
      try { lang = String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase(); } catch (e) { lang = ''; }
      if (lang.indexOf('ko') === 0) return 'ko';
      if (lang.indexOf('zh') === 0) return 'zh';
      return 'en';
    }

    function interpolate(str, vars) {
      if (!vars) return str;
      return str.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] != null ? String(vars[k]) : m));
    }

    function makeT(bound) {
      return (key, vars) => {
        let s = null;
        if (typeof bound === 'function') {
          try {
            const v = bound(key);
            if (typeof v === 'string' && v && v !== key) s = v;
          } catch (e) { s = null; }
        }
        if (s === null) {
          const d = DICT[fallbackLang()] || DICT.en;
          s = d[key] != null ? d[key] : (DICT.en[key] != null ? DICT.en[key] : key);
        }
        return interpolate(s, vars);
      };
    }

    const CSS = `
.dwfc-root{width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:4px 0 16px;color:var(--dsw-alias-label-primary,#1d1d1f);font:var(--dsw-font-s-14,400 14px/20px system-ui,sans-serif);}
.dwfc-root button:focus-visible,.dwfc-root input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px;}
.dwfc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
.dwfc-title{font:var(--dsw-font-s-strong-14,600 14px/20px system-ui,sans-serif);}
.dwfc-muted{font:var(--dsw-font-xs-13,400 13px/18px system-ui,sans-serif);color:var(--dsw-alias-label-secondary,#6b6b6b);}
.dwfc-btn{height:30px;padding:0 12px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2,#d0d0d0);background:transparent;color:var(--dsw-alias-label-primary,#1d1d1f);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;flex:none;}
.dwfc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f2f2f2);}
.dwfc-btn:disabled{opacity:.5;cursor:default;}
.dwfc-btn-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:var(--dsw-alias-bg-layer-1,#fff);}
.dwfc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4d6bfe);filter:brightness(1.08);}
.dwfc-btn-danger{color:var(--dsw-alias-state-error-primary,#d93025);}
.dwfc-icon{width:30px;padding:0;}
.dwfc-cards{display:flex;flex-direction:column;gap:8px;}
.dwfc-card{border:0.5px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);padding:12px 14px;display:flex;flex-direction:column;gap:10px;}
.dwfc-card-off{opacity:.65;}
.dwfc-card-head{display:flex;align-items:center;gap:10px;}
.dwfc-order{width:22px;height:22px;border-radius:50%;background:var(--dsw-alias-bg-layer-2,#f2f2f7);display:inline-flex;align-items:center;justify-content:center;font-size:12px;color:var(--dsw-alias-label-secondary,#6b6b6b);flex:none;}
.dwfc-name{font-weight:600;flex:1;min-width:0;}
.dwfc-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.dwfc-label{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;}
.dwfc-num{width:72px;height:28px;box-sizing:border-box;padding:0 8px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2,#d0d0d0);background:transparent;color:inherit;font:inherit;font-size:13px;}
.dwfc-key{flex:1;min-width:180px;height:30px;box-sizing:border-box;padding:0 10px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2,#d0d0d0);background:transparent;color:inherit;font:inherit;font-size:13px;}
.dwfc-status{display:inline-flex;align-items:center;gap:8px;font-size:13px;}
.dwfc-dot{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px color-mix(in srgb,currentColor 20%,transparent);margin:0 4px;flex:none;}
.dwfc-ok{color:var(--dsw-alias-state-success-primary,#1e9e5a);}
.dwfc-none{color:var(--dsw-alias-label-tertiary,#999);}
.dwfc-mask{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);color:var(--dsw-alias-label-primary,#1d1d1f);}
.dwfc-warn{font-size:13px;color:var(--dsw-alias-state-warning-primary,#b26b00);}
.dwfc-foot{display:flex;flex-direction:column;gap:8px;border-top:0.5px solid var(--dsw-alias-border-l1,#e5e5e5);padding-top:12px;}
.dwfc-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center;}
.dwfc-banner{padding:8px 12px;border-radius:8px;font-size:13px;line-height:18px;border:0.5px solid var(--dsw-alias-border-l2,#d0d0d0);background:var(--dsw-alias-bg-layer-2,#f2f2f7);display:flex;gap:8px;align-items:flex-start;}
.dwfc-banner-ok{color:var(--dsw-alias-state-success-primary,#1e9e5a);border-color:var(--dsw-alias-state-success-primary,#1e9e5a);}
.dwfc-banner-err{color:var(--dsw-alias-state-error-primary,#d93025);border-color:var(--dsw-alias-state-error-primary,#d93025);}
.dwfc-banner span{flex:1;min-width:0;word-break:break-word;}
.dwfc-x{background:none;border:none;padding:0 4px;cursor:pointer;color:inherit;font-size:16px;line-height:18px;}
.dwfc-toast{position:fixed;right:20px;bottom:20px;z-index:1000;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,.18);background:var(--dsw-alias-bg-layer-1,#fff);}
.dwfc-empty{padding:16px;text-align:center;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;border:0.5px dashed var(--dsw-alias-border-l2,#d0d0d0);border-radius:12px;}
`;

    function Banner(p) {
      const cls = 'dwfc-banner' + (p.kind === 'error' ? ' dwfc-banner-err' : p.kind === 'ok' ? ' dwfc-banner-ok' : '') + (p.toast ? ' dwfc-toast' : '');
      return h('div', { className: cls, role: p.kind === 'error' ? 'alert' : 'status' },
        h('span', null, p.text),
        p.onClose ? h('button', { type: 'button', className: 'dwfc-x', 'aria-label': p.t('dismiss'), onClick: p.onClose }, '×') : null);
    }

    const clone = (v) => JSON.parse(JSON.stringify(v));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    function KeyBlock(p) {
      const t = p.t;
      const key = p.keyInfo || { configured: false };
      const name = STEP_NAMES[p.step];
      const [value, setValue] = useState('');
      const [busy, setBusy] = useState(null);
      const run = async (kind, fn) => {
        setBusy(kind);
        try { await fn(); } finally { setBusy(null); }
      };
      const editable = p.keysEditable;
      const sourceText = key.source ? t('source_' + key.source) : '';
      return h('div', { className: 'dwfc-row', style: { flexDirection: 'column', alignItems: 'stretch', gap: '8px' } },
        h('div', { className: 'dwfc-status' },
          h('span', { className: 'dwfc-muted', style: { minWidth: '52px' } }, t('apiKey')),
          key.configured
            ? h(React.Fragment, null,
                h('span', { className: 'dwfc-dot dwfc-ok', 'aria-hidden': 'true' }),
                h('span', { className: 'dwfc-ok' }, t('keySet')),
                key.masked ? h('span', { className: 'dwfc-mask' }, key.masked) : null,
                sourceText ? h('span', { className: 'dwfc-muted' }, '· ' + sourceText) : null)
            : h(React.Fragment, null,
                h('span', { className: 'dwfc-dot dwfc-none', 'aria-hidden': 'true' }),
                h('span', { className: 'dwfc-none' }, t('keyUnset')))),
        !key.configured && p.enabled ? h('div', { className: 'dwfc-warn' }, '⚠ ' + t('skipped')) : null,
        h('div', { className: 'dwfc-row' },
          h('input', {
            type: 'password', className: 'dwfc-key', value: value, autoComplete: 'off', spellCheck: false,
            'aria-label': name + ' ' + t('apiKey'),
            placeholder: key.configured ? t('keyPlaceholderSet') : t('keyPlaceholder'),
            disabled: !editable || busy !== null,
            onChange: (e) => setValue(e.target.value),
          }),
          h('button', {
            type: 'button', className: 'dwfc-btn dwfc-btn-primary', disabled: !editable || busy !== null || value.trim() === '',
            onClick: () => run('save', async () => { if (await p.onSave(value)) setValue(''); }),
          }, t('saveKey')),
          h('button', {
            type: 'button', className: 'dwfc-btn', disabled: busy !== null || (!key.configured && value.trim() === ''),
            onClick: () => run('test', () => p.onTest(value)),
          }, busy === 'test' ? t('testing') : t('test')),
          key.deletable ? h('button', {
            type: 'button', className: 'dwfc-btn dwfc-btn-danger', disabled: !editable || busy !== null,
            onClick: () => run('delete', () => p.onDelete()),
          }, t('deleteKey')) : null),
        key.configured && key.source && key.source !== 'file' ? h('div', { className: 'dwfc-muted' }, t('envNote')) : null);
    }

    function StepCard(p) {
      const t = p.t;
      const step = p.row.step;
      const name = STEP_NAMES[step];
      const seconds = p.timeouts[step];
      return h('div', { className: 'dwfc-card' + (p.row.enabled ? '' : ' dwfc-card-off') },
        h('div', { className: 'dwfc-card-head' },
          h('span', { className: 'dwfc-order' }, String(p.index + 1)),
          h('span', { className: 'dwfc-name' }, name),
          h('label', { className: 'dwfc-label' },
            h('input', { type: 'checkbox', checked: p.row.enabled, disabled: !p.editable, onChange: (e) => p.onToggle(e.target.checked) }),
            t('enabled')),
          h('button', { type: 'button', className: 'dwfc-btn dwfc-icon', disabled: !p.editable || p.index === 0, 'aria-label': t('moveUp', { step: name }), title: t('moveUp', { step: name }), onClick: () => p.onMove(-1) }, '↑'),
          h('button', { type: 'button', className: 'dwfc-btn dwfc-icon', disabled: !p.editable || p.index === p.count - 1, 'aria-label': t('moveDown', { step: name }), title: t('moveDown', { step: name }), onClick: () => p.onMove(1) }, '↓')),
        h('div', { className: 'dwfc-row' },
          h('label', { className: 'dwfc-label' },
            h('span', { className: 'dwfc-muted', style: { minWidth: '52px' } }, t('timeout')),
            h('input', {
              type: 'number', className: 'dwfc-num', min: 1, max: 300, step: 1, value: seconds, disabled: !p.editable,
              onChange: (e) => p.onTimeout(e.target.value),
            }),
            t('seconds')),
          ...(OPTIONS[step] || []).map(([field, label]) => h('label', { className: 'dwfc-label', key: field },
            h('input', { type: 'checkbox', checked: !!p.options[field], disabled: !p.editable, onChange: (e) => p.onOption(field, e.target.checked) }),
            t(label)))),
        PAID.indexOf(step) !== -1 ? h(KeyBlock, {
          t: t, step: step, enabled: p.row.enabled, keyInfo: p.keyInfo, keysEditable: p.keysEditable,
          onSave: p.onSaveKey, onDelete: p.onDeleteKey, onTest: p.onTestKey,
        }) : null);
    }

    /** Page form: the Host view with timeouts in seconds, which is what the inputs edit. */
    function toForm(settings) {
      const form = clone(settings);
      for (const step of Object.keys(form.timeouts)) form.timeouts[step] = String(Math.round(form.timeouts[step] / 1000));
      return form;
    }

    function fromForm(form) {
      const out = clone(form);
      for (const step of Object.keys(out.timeouts)) {
        const s = Number(out.timeouts[step]);
        if (!Number.isInteger(s) || s < 1 || s > 300) return null;
        out.timeouts[step] = s * 1000;
      }
      return out;
    }

    function SettingsPage(p) {
      const t = p.t;
      const [state, setState] = useState(null);
      const [form, setForm] = useState(null);
      const [loadError, setLoadError] = useState(null);
      const [loading, setLoading] = useState(false);
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState(null);
      const mounted = useRef(true);
      const noticeTimer = useRef(null);
      useEffect(() => () => { mounted.current = false; clearTimeout(noticeTimer.current); }, []);

      const notify = useCallback((kind, text) => {
        clearTimeout(noticeTimer.current);
        setNotice({ kind: kind, text: text });
        noticeTimer.current = setTimeout(() => { if (mounted.current) setNotice(null); }, NOTICE_MS);
      }, []);

      const apply = (value) => { setState(value); setForm(toForm(value.settings)); };

      const load = useCallback(async () => {
        setLoading(true);
        try {
          const value = await p.rpc('state');
          if (!mounted.current) return;
          apply(value);
          setLoadError(null);
        } catch (e) {
          if (mounted.current) setLoadError(e.message || t('requestFailed'));
        } finally {
          if (mounted.current) setLoading(false);
        }
      }, [p.rpc]);
      useEffect(() => { load(); }, [load]);

      if (!state || !form) {
        return h('div', { className: 'dwfc-root' },
          loadError ? h(Banner, { t: t, kind: 'error', text: loadError }) : h('div', { className: 'dwfc-empty' }, t('loading')));
      }

      const editable = state.editable && !saving;
      const dirty = !same(form, toForm(state.settings));
      const parsed = fromForm(form);
      const budget = parsed
        ? parsed.steps.filter((r) => r.enabled).reduce((sum, r) => sum + parsed.timeouts[r.step] / 1000, BUDGET_MARGIN_S)
        : null;

      const update = (fn) => setForm((prev) => { const next = clone(prev); fn(next); return next; });
      const move = (index, delta) => update((f) => {
        const j = index + delta;
        if (j < 0 || j >= f.steps.length) return;
        const tmp = f.steps[index]; f.steps[index] = f.steps[j]; f.steps[j] = tmp;
      });

      const save = async () => {
        if (!parsed) { notify('error', t('timeoutRange')); return; }
        setSaving(true);
        try {
          await p.rpc('save', { settings: parsed });
          // The plugin restarts after the save; its routes come back with it.
          let fresh = null;
          for (let i = 0; i < 10 && mounted.current && !fresh; i++) {
            await new Promise((r) => setTimeout(r, 300));
            try { fresh = await p.rpc('state'); } catch (e) { fresh = null; }
          }
          if (!mounted.current) return;
          if (fresh) apply(fresh);
          notify('ok', t('saved'));
        } catch (e) {
          if (mounted.current) notify('error', e.message || t('requestFailed'));
        } finally {
          if (mounted.current) setSaving(false);
        }
      };

      const setKeyInfo = (step, info) => setState((prev) => Object.assign({}, prev, { keys: Object.assign({}, prev.keys, { [step]: info }) }));
      const keyHandlers = (step) => {
        const name = STEP_NAMES[step];
        return {
          onSaveKey: async (value) => {
            try {
              const r = await p.rpc('setKey', { step: step, value: value });
              if (mounted.current) { setKeyInfo(step, r.key); notify('ok', t('keySaved', { step: name })); }
              return true;
            } catch (e) { if (mounted.current) notify('error', e.message || t('requestFailed')); return false; }
          },
          onDeleteKey: async () => {
            if (!window.confirm(t('confirmDelete', { step: name }))) return;
            try {
              const r = await p.rpc('deleteKey', { step: step });
              if (mounted.current) { setKeyInfo(step, r.key); notify('ok', t('keyDeleted', { step: name })); }
            } catch (e) { if (mounted.current) notify('error', e.message || t('requestFailed')); }
          },
          onTestKey: async (value) => {
            try {
              const r = await p.rpc('checkKey', { step: step, value: value });
              if (!mounted.current) return;
              if (r.ok) notify('ok', t('checkOk', { step: name }));
              else notify('error', t('check_' + r.reason, { step: name, status: r.status, message: r.message }));
            } catch (e) { if (mounted.current) notify('error', e.message || t('requestFailed')); }
          },
        };
      };

      return h('div', { className: 'dwfc-root' },
        h('div', { className: 'dwfc-head' },
          h('div', null,
            h('div', { className: 'dwfc-title' }, t('title')),
            h('div', { className: 'dwfc-muted' }, t('intro'))),
          h('button', { type: 'button', className: 'dwfc-btn', disabled: loading || saving, onClick: load }, loading ? t('loading') : t('refresh'))),
        !state.editable ? h(Banner, { t: t, text: t('readOnly') }) : null,
        !state.keysEditable ? h(Banner, { t: t, text: t('keysReadOnly') }) : null,
        loadError ? h(Banner, { t: t, kind: 'error', text: loadError, onClose: () => setLoadError(null) }) : null,
        h('div', { className: 'dwfc-cards' },
          ...form.steps.map((row, index) => h(StepCard, Object.assign({
            key: row.step, t: t, row: row, index: index, count: form.steps.length,
            timeouts: form.timeouts, options: form.options, editable: editable,
            keyInfo: state.keys[row.step], keysEditable: state.keysEditable,
            onToggle: (on) => update((f) => { f.steps[index].enabled = on; }),
            onMove: (delta) => move(index, delta),
            onTimeout: (v) => update((f) => { f.timeouts[row.step] = v; }),
            onOption: (field, on) => update((f) => { f.options[field] = on; }),
          }, keyHandlers(row.step))))),
        h('div', { className: 'dwfc-foot' },
          h('label', { className: 'dwfc-label' },
            h('input', { type: 'checkbox', checked: form.raiseWebFetchTimeout, disabled: !editable, onChange: (e) => update((f) => { f.raiseWebFetchTimeout = e.target.checked; }) }),
            t('raise')),
          h('div', { className: 'dwfc-muted' }, budget === null ? t('timeoutRange') : t('budget', { s: budget, m: BUDGET_MARGIN_S })),
          h('div', { className: 'dwfc-actions' },
            h('span', { className: 'dwfc-muted', style: { flex: 1 } }, dirty ? t('saveNote') : ''),
            h('button', { type: 'button', className: 'dwfc-btn', disabled: !dirty || saving, onClick: () => setForm(toForm(state.settings)) }, t('revert')),
            h('button', { type: 'button', className: 'dwfc-btn dwfc-btn-primary', disabled: !editable || !dirty || !parsed, onClick: save }, saving ? t('saving') : t('save')))),
        notice ? h(Banner, { t: t, kind: notice.kind, text: notice.text, toast: true, onClose: () => setNotice(null) }) : null);
    }

    return {
      inject: ['slots', 'connection', 'locale'],
      apply(ctx) {
        try { ctx.effect(() => ctx.locale.register('dsh-web-fetch-chain', DICT)); } catch (e) { /* optional */ }
        const bound = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind('dsh-web-fetch-chain') : null;
        const t = makeT(bound);
        const rpc = async (endpoint, payload = {}) => {
          const r = await ctx.connection.rpc.call('/api', 'web-fetch-chain.' + endpoint, payload);
          if (r && r.ok) return r.value;
          throw new Error((r && r.error && r.error.message) || t('requestFailed'));
        };
        ctx.effect(() => {
          const el = document.createElement('style');
          el.textContent = CSS;
          document.head.appendChild(el);
          return () => el.remove();
        });
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-web-fetch-chain',
        }, (props) => (props && props.view === 'summary') ? t('summary') : h(SettingsPage, { rpc: rpc, t: t })));
      },
    };
  },
});
