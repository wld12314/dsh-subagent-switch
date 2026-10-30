/**
 * 子代理模型切换（subagent-switch）—— Client 半边。
 *
 * 左侧栏一个「子代理模型切换」条目，点开是主面板：
 *   · 本地模型目录（来自宿主 ctx.llm）按档位分组的实时清单
 *   · 每个模型的可用状态 / 能力标签 goodAt · badAt / 额度
 *   · routingTable（任务类型 → 默认模型）
 *
 * 数据全部走宿主半边开的 HTTP 接口 /subagent-switch-api。
 * 面板只读 + 重新读取；真正的切换由宿主半 wrap startActivation 完成。
 */
window.__ModuleLoader__.load({
  id: '@local/subagent-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/subagent-switch-api'
    const MONO = '"JetBrains Mono", "Cascadia Code", "SFMono-Regular", Consolas, monospace'

    async function api(path) {
      const res = await fetch(API + path, { headers: { accept: 'application/json' } })
      let data = {}
      try {
        data = await res.json()
      } catch {
        /* 空响应 */
      }
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
      return data
    }

    // Only two endpoints mutate anything, and both write the plugin's own
    // overrides file. Kept separate from api() so a read error never looks like
    // a failed write.
    async function apiPost(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      })
      let data = {}
      try {
        data = await res.json()
      } catch {
        /* 空响应 */
      }
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
      return data
    }

    const CSS = `
.ss-root{height:100%;min-height:520px;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}
.ss-bar{display:flex;align-items:center;gap:10px;padding:18px 28px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.ss-bar h1{margin:0;font-size:17px;font-weight:600;letter-spacing:.01em}
.ss-bar .sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ss-bar .spacer{flex:1}
.ss-scroll{flex:1;overflow:auto;padding:20px 28px 80px}
.ss-note{max-width:1180px;font-size:12.5px;line-height:1.75;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 16px;margin-bottom:18px}
.ss-note b{color:var(--dsw-alias-label-primary);font-weight:600}
.ss-muted{color:var(--dsw-alias-label-tertiary)}
.ss-muted b{color:var(--dsw-alias-label-secondary);font-weight:600}
.ss-h2{max-width:1180px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;margin:22px 0 10px}
.ss-table{width:100%;max-width:1180px;border-collapse:separate;border-spacing:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}
.ss-table th{text-align:left;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.03em;padding:11px 14px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.ss-table td{padding:11px 14px;vertical-align:top;border-bottom:1px solid var(--dsw-alias-border-l1);line-height:1.65}
.ss-table tr:last-child td{border-bottom:none}
.ss-name{font-family:${MONO};font-size:12px;font-weight:600;white-space:nowrap}
.ss-prov{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-family:${MONO};white-space:nowrap}
.ss-chip{font-family:${MONO};font-size:11px;padding:2px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1);display:inline-block;margin:0 4px 4px 0;white-space:nowrap}
.ss-chip.alt{background:transparent;color:var(--dsw-alias-label-secondary)}
.ss-chip.tier{background:transparent;color:var(--dsw-alias-label-secondary);letter-spacing:.03em}
.ss-ok{color:var(--dsw-alias-label-secondary)}
.ss-bad{color:var(--dsw-alias-label-danger,#d9534f)}
.ss-warn{color:var(--dsw-alias-label-warning,var(--dsw-alias-label-secondary))}
.ss-err{max-width:1180px;color:var(--dsw-alias-label-danger,#d9534f);font-size:12.5px;line-height:1.8}
.ss-empty{color:var(--dsw-alias-label-secondary);font-size:12.5px}
.ss-btn{font-size:12px;padding:4px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ss-src{font-family:${MONO};font-size:10.5px;font-weight:500;padding:1px 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);margin-left:7px;vertical-align:middle;white-space:nowrap}
.ss-src.own{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-label-tertiary)}
.ss-cat{font-family:${MONO};font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.ss-prio{display:flex;align-items:center;gap:4px;white-space:nowrap}
.ss-prio .val{font-family:${MONO};font-size:11.5px;min-width:22px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.ss-prio .val.on{color:var(--dsw-alias-label-primary);font-weight:600}
.ss-step{width:20px;height:20px;line-height:1;padding:0;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px}
.ss-step:disabled{opacity:.4;cursor:default}
.ss-step.on{border-color:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-primary)}
.ss-toggle{font-size:11px;padding:2px 8px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;margin-top:4px}
.ss-toggle.on{border-color:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-primary)}
.ss-toggle:disabled{opacity:.4;cursor:default}
.ss-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.6;margin-top:2px}
`

    function SwitchIcon(props) {
      const size = (props && props.size) || 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M4 8h12l-2.6-2.6M20 16H8l2.6 2.6',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 6.4, cy: 16, r: 2, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('circle', { cx: 17.6, cy: 8, r: 2, stroke: 'currentColor', strokeWidth: 1.5 }),
      )
    }

    // Domain ids stay English everywhere they are compared: matchScore() and
    // the preset regexes compare raw strings, and config.tags / presets / the
    // task classifier all speak those ids. This table is DISPLAY ONLY — it
    // never feeds back into routing. Unknown ids fall back to the raw string,
    // so a user's custom domain still shows up instead of vanishing.
    const DOMAIN_LABELS = {
      coding: '编码',
      research: '调研',
      writing: '写作',
      summarize: '摘要',
      analysis: '分析',
      vision: '视觉',
      'long-context': '长文本',
      agentic: '自主任务',
      office: '办公文档',
      background: '后台任务',
      general: '通用',
    }

    function domainLabel(id) {
      return DOMAIN_LABELS[id] || id
    }

    function chipList(list, alt, label) {
      if (!Array.isArray(list) || !list.length) return h('span', { className: 'ss-empty' }, '—')
      return h(
        'div',
        null,
        list.map((m, i) =>
          h('span', { key: i, className: 'ss-chip' + (alt ? ' alt' : ''), title: m }, label ? label(m) : m),
        ),
      )
    }

    // Capability domains get a Chinese label. Model ids (blacklist) must NOT —
    // they are not domains, and a mistranslation there would be a lie.
    function chips(list, alt) {
      return chipList(list, alt, domainLabel)
    }

    function plainChips(list, alt) {
      return chipList(list, alt, null)
    }

    // Where the tags came from decides how much they're worth: config is
    // hand-written and trusted, preset is a family-level guess. Without this
    // marker a guessed tag looks exactly as authoritative as a written one,
    // and the routing decisions they drive become unauditable.
    function tagSourceMark(m) {
      if (m.tagSource === 'config') return h('span', { className: 'ss-src own', title: '来自 config.tags，手写' }, '手写')
      if (m.tagSource === 'preset') return h('span', { className: 'ss-src', title: '来自内置家族表推测，未必准确' }, '推测')
      return h('span', { className: 'ss-src', title: '没有任何能力标签，打分一律 0' }, '无标签')
    }

    function statusCell(m) {
      // Gate check comes first: a model can be perfectly "available" yet still
      // be excluded from automatic routing because its provider publishes no
      // readable balance and is not account-backed. Showing plain "可用" there
      // would make the pool look bigger than it is.
      if (m.status === 'available' && m.routable === false) {
        return h(
          'span',
          { className: 'ss-warn', title: '该 provider 没有可读余额，也不是账号接入，所以不参与自动路由' },
          '仅列出 · 不路由',
        )
      }
      if (m.status === 'available') return h('span', { className: 'ss-ok' }, m.quota === '未知' ? '可用' : `可用 · ${m.quota}`)
      if (m.status === 'excluded') return h('span', { className: 'ss-warn' }, '黑名单')
      if (m.status === 'unavailable') return h('span', { className: 'ss-bad' }, '目录不可见')
      return h('span', { className: 'ss-warn' }, `额度用尽${m.quota && m.quota !== '用尽' ? ` · ${m.quota}` : ''}`)
    }

    // Manual priority. Two button-pairs would need explaining, so it is just
    // ↑/↓ stepping by 1 with a reset. The value is shown even at 0 because
    // "0" IS a state: it means the router decides, not that the model is bad.
    function PriorityCell({ model, busy, onStep }) {
      const value = typeof model.priority === 'number' ? model.priority : 0
      const atMin = value <= -100
      const atMax = value >= 100
      return h(
        'div',
        { className: 'ss-prio' },
        h(
          'button',
          {
            type: 'button',
            className: 'ss-step',
            disabled: busy || atMin,
            title: atMin ? '已经是最低优先级' : '降低优先级（-1）',
            onClick: () => onStep(model, value - 1),
          },
          '↓',
        ),
        h('span', { className: `val${value !== 0 ? ' on' : ''}`, title: value === 0 ? '自动决定（按能力分）' : `手动优先级 ${value}` }, value),
        h(
          'button',
          {
            type: 'button',
            className: 'ss-step',
            disabled: busy || atMax,
            title: atMax ? '已经是最高优先级' : '提高优先级（+1）',
            onClick: () => onStep(model, value + 1),
          },
          '↑',
        ),
      )
    }

    function ModelTable({ models, busyId, onStep, onToggleRoutable }) {
      if (!Array.isArray(models) || !models.length) {
        return h('div', { className: 'ss-empty' }, '宿主没有返回任何模型（检查 DSH 的模型目录是否已配置）。')
      }
      return h(
        'table',
        { className: 'ss-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '模型'),
            h('th', null, '档位'),
            h('th', null, '状态'),
            h('th', { title: '手动优先级。大于 0 就压过能力分参与选择，也压过档位顺序；0 表示自动' }, '优先级'),
            h('th', null, '擅长'),
            h('th', null, '不擅长'),
          ),
        ),
        h(
          'tbody',
          null,
          models.map((m, i) =>
            h(
              'tr',
              { key: i },
              h(
                'td',
                null,
                h('div', { className: 'ss-name' }, m.name || '—', tagSourceMark(m)),
                // Always show the canonical id: two catalog entries can share a
                // display name (Hy3 · x0.00 vs Hy3 · x0.05 → hy3 vs hy3-x) and
                // the id is what blacklist / defaultModel actually key on.
                h('div', { className: 'ss-prov' }, m.id || m.provider || ''),
              ),
              h('td', null, h('span', { className: 'ss-chip tier' }, m.tier || '未知')),
              h(
                'td',
                null,
                statusCell(m),
                // A model kept out of the pool only because no balance is
                // readable can be released one at a time. That is the whole
                // "想用就自己放行" story from config, now a button.
                m.status === 'available' && m.routable === false
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'ss-toggle',
                        disabled: busyId === m.id,
                        title: '放行这一个模型：让它进入自动路由候选池（写进插件的 overrides 文件）',
                        onClick: () => onToggleRoutable(m, true),
                      },
                      busyId === m.id ? '处理中…' : '放行',
                    )
                  : m.forceRoutable
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'ss-toggle on',
                          disabled: busyId === m.id,
                          title: '这个模型是被手动放行的。点一下收回放行，恢复「仅列出 · 不路由」',
                          onClick: () => onToggleRoutable(m, false),
                        },
                        busyId === m.id ? '处理中…' : '已放行 · 收回',
                      )
                    : null,
              ),
              h('td', null, h(PriorityCell, { model: m, busy: busyId === m.id, onStep })),
              h('td', null, chips(m.goodAt, false)),
              h('td', null, chips(m.badAt, true)),
            ),
          ),
        ),
      )
    }

    function RoutingTable({ rows }) {
      if (!Array.isArray(rows) || !rows.length) {
        return h('div', { className: 'ss-empty' }, '还没有 routingTable 条目；子代理会走 capability 打分 + 档位顺序。')
      }
      return h(
        'table',
        { className: 'ss-table' },
        h('thead', null, h('tr', null, h('th', null, '任务类型'), h('th', null, '指定模型'))),
        h(
          'tbody',
          null,
          rows.map((r, i) =>
            h(
              'tr',
              { key: i },
              h('td', null, r.category || 'general'),
              h('td', null, r.defaultModel ? h('span', { className: 'ss-chip' }, r.defaultModel) : h('span', { className: 'ss-empty' }, '自动')),
            ),
          ),
        ),
      )
    }

    // The whole point of this table: show whether a category is actually
    // matched or merely fell back. A 0-score pick and a real capability win
    // look identical in the model list, and that ambiguity is what makes
    // routing feel arbitrary when a cheap generalist keeps winning.
    function MatchCell(r) {
      if (r.matched === true) {
        if (!r.escalated) return h('span', { className: 'ss-ok' }, `匹配 +${r.score}`)
        // Escalation spent more money on purpose. Saying so keeps a pricier
        // model from looking like the normal outcome — and shows the trade was
        // deliberate (the cheap band had no match), not a scoring accident.
        const skipped = r.skipped || {}
        return h(
          'span',
          {
            className: 'ss-ok',
            title:
              `便宜档 ${(skipped.band || []).join('+') || '—'} 里 ${skipped.candidates ?? '?'} 个候选没一个擅长该任务` +
              `（最靠前的是 ${skipped.modelName || skipped.modelId || '—'}，${skipped.score ?? 0} 分），为了匹配升级到了更贵的档`,
          },
          `匹配 +${r.score} · 升级付费`,
        )
      }
      if (r.matched === false) {
        if (r.reason === 'route-table' || r.reason === 'default-model') {
          return h('span', { className: 'ss-warn', title: '这一档没有评分的环节，模型由配置指定' }, '人工指定')
        }
        // Negative and zero are different failures: negative means the band's
        // models all say they are BAD at this task, zero means none of them
        // said anything at all. Calling both "兜底 0 分" would hide the worse one.
        if (typeof r.score === 'number' && r.score < 0) {
          return h(
            'span',
            {
              className: 'ss-bad',
              title: '这一档里所有候选都声明自己不擅长该任务，选中的是最不差的那个',
            },
            `全都标了不擅长 ${r.score}`,
          )
        }
        return h(
          'span',
          { className: 'ss-warn', title: '这一档没有任何模型声明擅长该任务，选中结果是 0 分并列后按目录顺序取的' },
          `兜底 0 分${typeof r.candidates === 'number' ? ` · ${r.candidates} 个并列` : ''}`,
        )
      }
      return h('span', { className: 'ss-muted' }, typeof r.score === 'number' ? `${r.score}` : '—')
    }

    function RoutePreview({ rows, onRefresh }) {
      if (!Array.isArray(rows)) return h('div', { className: 'ss-empty' }, '读取中…')
      return h(
        'table',
        { className: 'ss-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '任务类型'),
            h('th', null, '会选中'),
            h('th', null, '档位'),
            h('th', null, '匹配'),
            h('th', null, '依据'),
          ),
        ),
        h(
          'tbody',
          null,
          rows.map((r, i) =>
            h(
              'tr',
              { key: i },
              h('td', null, h('span', { className: 'ss-cat' }, r.category || 'general')),
              h(
                'td',
                null,
                r.model
                  ? h('div', null, h('span', { className: 'ss-name' }, r.model.name || r.model.id || '—'))
                  : h('span', { className: 'ss-bad' }, '无可用模型'),
              ),
              h('td', null, h('span', { className: 'ss-chip tier' }, r.tier || (r.model && r.model.tier) || '—')),
              h('td', null, h(MatchCell, r)),
              h('td', null, h('span', { className: 'ss-cat' }, r.reason || '')),
            ),
          ),
        ),
      )
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [models, setModels] = useState(null)
      const [routes, setRoutes] = useState(null)
      const [error, setError] = useState('')
      const [busyId, setBusyId] = useState('')
      const [writeError, setWriteError] = useState('')

      const load = useCallback(() => {
        setError('')
        // /routes is best-effort: it re-reads the whole catalog to score every
        // category, so a failure there must not blank out the model list.
        Promise.all([
          api('/state'),
          api('/models'),
          api('/routes').catch(() => null),
        ])
          .then(([s, m, r]) => {
            setState(s)
            setModels(m)
            setRoutes(r && Array.isArray(r.rows) ? r.rows : null)
          })
          .catch((e) => setError(String((e && e.message) || e)))
      }, [])

      useEffect(() => {
        load()
      }, [load])

      // Both writes return the fresh value; reloading afterwards is what makes
      // the routing preview change in front of the user instead of silently
      // taking effect on the next spawn.
      const runWrite = useCallback(
        (model, request) => {
          setBusyId(model.id || '')
          setWriteError('')
          request()
            .then((out) => {
              if (out && out.saved === false) {
                // Live change, not durable. Say it instead of pretending.
                setWriteError(`改动已生效，但写盘失败${out.error ? `：${out.error}` : ''}（重启后会丢失）`)
              }
              load()
            })
            .catch((e) => setWriteError(String((e && e.message) || e)))
            .finally(() => setBusyId(''))
        },
        [load],
      )

      const onStep = useCallback(
        (model, next) => {
          runWrite(model, () => apiPost('/priority', { id: model.id, priority: next }))
        },
        [runWrite],
      )

      const onToggleRoutable = useCallback(
        (model, next) => {
          runWrite(model, () => apiPost('/routable', { id: model.id, routable: next }))
        },
        [runWrite],
      )

      const tiers = (models && Array.isArray(models.tiers) && models.tiers.length) ? models.tiers.join(' > ') : ''
      const pinned = state && state.priority && typeof state.priority === 'object' ? state.priority : {}
      const pinnedCount = Object.keys(pinned).length

      return h(
        'div',
        { className: 'ss-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'div',
          { className: 'ss-bar' },
          h('h1', null, (state && state.title) || '子代理模型切换'),
          h('span', { className: 'sub' }, '起子代理时按任务挑模型'),
          h('span', { className: 'spacer' }),
          h('button', { type: 'button', className: 'ss-btn', onClick: load }, '重新读取'),
        ),
        h(
          'div',
          { className: 'ss-scroll' },
          error
            ? h('div', { className: 'ss-err' }, `读不到模型清单：${error}`)
            : !models
              ? h('div', { className: 'ss-empty' }, '读取中…')
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'ss-note' },
                    '子代理启动时，宿主半读本地模型目录，按「能力匹配优先、再按档位顺序」挑一个模型塞进该子代理的 ',
                    h('b', null, 'agentOptions'),
                    '。免费档优先于配额档，配额档优先于付费档；额度归零的模型直接移出候选池。',
                    tiers ? h('div', { style: { marginTop: 6 } }, h('b', null, '档位顺序：'), tiers) : null,
                    state && Array.isArray(state.excludedProviders) && state.excludedProviders.length
                      ? h(
                          'div',
                          { style: { marginTop: 6 }, className: 'ss-muted' },
                          h('b', null, '已忽略 provider：'),
                          state.excludedProviders.join('、'),
                          '（这些 provider 下的模型不计入候选池，也不发起读取；想加回来改 config 的 excludedProviders）',
                        )
                      : null,
                    h(
                      'div',
                      { style: { marginTop: 6 }, className: 'ss-muted' },
                      h('b', null, '参与自动路由的 provider：'),
                      Array.isArray(state && state.accountBackedProviders) && state.accountBackedProviders.length
                        ? state.accountBackedProviders.join('、')
                        : '（未配置）',
                      '。只有账号接入的 provider 才会被自动选中；余额可读的那几家会额外做余额校验。',
                      '其余模型仍然列在下面的表里、状态标「仅列出 · 不路由」，随时会清零额度的免费池就属于这一类 ——',
                      '想用其中某一个，直接在表里点它下面的「放行」（或写 config 的 routableOverrides）。',
                    ),
                    state && state.escalateOnMiss === false
                      ? h(
                          'div',
                          { style: { marginTop: 6 }, className: 'ss-muted' },
                          h('b', null, '升级付费：'),
                          '已关闭（escalateOnMiss: false）—— 便宜档没有匹配时也留在便宜档。',
                        )
                      : h(
                          'div',
                          { style: { marginTop: 6 }, className: 'ss-muted' },
                          h('b', null, '升级付费：'),
                          '已开启 —— 便宜档（',
                          (Array.isArray(state && state.cheapBand) ? state.cheapBand.join('+') : '') || 'free+free_quota',
                          '）里没有任何模型擅长该任务时，会往上找真正擅长它的模型，哪怕更贵。',
                          '要求分数 ≥',
                          state && state.escalateMinScore !== undefined ? state.escalateMinScore : 1,
                          '；上面找不到真匹配就退回便宜档，不为另一个 0 分猜测多花钱。',
                          '关掉写 config 的 escalateOnMiss: false。',
                        ),
                    state && state.defaultModel
                      ? h('div', { style: { marginTop: 6 } }, h('b', null, '兜底模型：'), state.defaultModel)
                      : null,
                    h(
                      'div',
                      { style: { marginTop: 6 }, className: 'ss-muted' },
                      h('b', null, '手动优先级：'),
                      '下面每个模型有 ↑/↓，调到大于 0 就',
                      h('b', null, '压过能力分'),
                      '、也',
                      h('b', null, '压过档位顺序'),
                      '，并且不再升级到更贵的档 —— 因为那是你自己选的。0 表示交给自动规则。',
                      pinnedCount
                        ? ` 当前手动钉住 ${pinnedCount} 个。`
                        : ' 当前一个都没钉。',
                      '「放行」用来把「仅列出 · 不路由」的模型单独放进候选池。',
                      '这些改动只写进插件自己的 ',
                      h('b', null, 'subagent-switch-overrides.json'),
                      '，不碰 DSH 配置；',
                      h('b', null, '删掉这个文件就全部回到自动'),
                      '。',
                      state && state.overridesPath
                        ? h('div', { className: 'ss-hint', style: { wordBreak: 'break-all' } }, state.overridesPath)
                        : null,
                    ),
                  ),
                  writeError ? h('div', { className: 'ss-err' }, writeError) : null,
                  h('div', { className: 'ss-h2' }, '本次路由预览（按当前候选池重算一次）'),
                  h(RoutePreview, { rows: routes }),
                  h(
                    'div',
                    { className: 'ss-muted', style: { maxWidth: 1180, marginTop: 8, lineHeight: 1.75 } },
                    '「匹配」是模型自己声明擅长这个任务（打分 > 0）；「兜底」表示这一档里没有任何模型声明擅长，',
                    '只是若干模型同为 0 分、按目录顺序取到第一个 —— 那一次选择跟模型能力无关。',
                    '想改就写 config 的 ',
                    h('b', null, 'tags'),
                    ' 给具体模型手写擅长/不擅长，标「手写」的标签会盖过内置推测。',
                  ),
                  h('div', { className: 'ss-h2' }, `本地模型目录（${(models.models || []).length}）`),
                  h(ModelTable, { models: models.models, busyId, onStep, onToggleRoutable }),
                  h('div', { className: 'ss-h2' }, '任务类型 → 指定模型'),
                  h(RoutingTable, { rows: state && state.routingTable }),
                  Array.isArray(state && state.blacklist) && state.blacklist.length
                    ? h(
                        'div',
                        null,
                        h('div', { className: 'ss-h2' }, '黑名单'),
                        // Not domain tags: these are model ids, render as-is.
                        h('div', null, plainChips(state.blacklist, true)),
                      )
                    : null,
                ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        // 左侧栏条目：id 与 main 的 key 对应，点开即选中对应主面板。
        slots.inject('sidebar.panellist', () =>
          slots.register(
            { name: 'sidebar.panellist', id: 'subagent-switch', order: 11, label: '子代理模型切换' },
            SwitchIcon,
          ),
        )
        slots.inject('main', () => slots.register({ name: 'main', key: 'subagent-switch' }, Panel))
      },
    }
  },
})
