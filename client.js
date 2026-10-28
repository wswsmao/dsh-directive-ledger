/**
 * Browser half: a strip above the composer showing the requirements that are
 * still in force, and how each one came to be.
 *
 * It renders in `conversation.input.dock`, which gives the component
 * `useProjection` — the ledger arrives already folded by the Host, so this file
 * never reads session events itself. That is the whole point: the panel and the
 * model consume the same derived value, so the user and the agent can never
 * disagree about which requirement is current.
 *
 * @module directive-ledger-client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-directive-ledger',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useMemo, useState } = React

    const NS = 'directive-ledger'
    const STYLE_ID = '@local/dsh-directive-ledger/DirectiveDock.css'
    const PROJECTION_KEY = 'directiveLedger'
    /** Host route that performs a removal through the logged `/rule drop`. */
    const API = '/plugins/directive-ledger'

    // ------------------------------------------------------------------ copy

    const zh = {
      'meta.locale': 'zh-CN',
      'dock.title': '生效中的要求',
      'dock.count': '{count} 条',
      'dock.enforced': '{count} 条可拦截',
      'dock.expand': '展开全部',
      'dock.collapse': '收起',
      'group.active': '生效中',
      'group.superseded': '已取代',
      'group.revoked': '已撤销',
      'group.retracted': '已失效（原话被改写）',
      'kind.pin': '固定',
      'kind.ban': '禁止',
      'kind.rule': '规则',
      'kind.preference': '偏好',
      'kind.decision': '决定',
      'source.turn': '第 {turn} 轮',
      'dock.omitted': '未注入',
      'dock.remove': '删除这条要求：{text}',
      'replacedBy': '被「{text}」取代',
      'hint': '用 /rule list 查看、/rule drop 撤销；已有要求被改写时会自动更新。',
      'empty': '还没有识别到明确的长期要求。',
    }

    const en = {
      'meta.locale': 'en-US',
      'dock.title': 'Requirements in force',
      'dock.count': '{count}',
      'dock.enforced': '{count} enforced',
      'dock.expand': 'Show all',
      'dock.collapse': 'Collapse',
      'group.active': 'In force',
      'group.superseded': 'Replaced',
      'group.revoked': 'Revoked',
      'group.retracted': 'Invalidated (prompt rewritten)',
      'kind.pin': 'Pinned',
      'kind.ban': 'Prohibition',
      'kind.rule': 'Rule',
      'kind.preference': 'Preference',
      'kind.decision': 'Decision',
      'source.turn': 'turn {turn}',
      'dock.omitted': 'not injected',
      'dock.remove': 'Remove this requirement: {text}',
      'replacedBy': 'replaced by “{text}”',
      'hint': 'Use /rule list to review and /rule drop to revoke; rewriting a prompt updates it automatically.',
      'empty': 'No standing requirement detected yet.',
    }

    // ----------------------------------------------------------------- style

    /**
     * Match the composer card's geometry.
     *
     * The dock entry and the input box are siblings in the same `composerStack`,
     * but the input box sits inside a wrapper carrying
     * `padding: 0 var(--dsh-composer-side-clearance)` and caps itself at
     * `--dsh-composer-card-max-width`. A dock entry has neither, so without this
     * rule it spans the full conversation column while the input stays centred —
     * the card overhangs the box it describes.
     *
     * Reproducing the wrapper's padding as a width subtraction, then applying the
     * same cap and `margin: 0 auto`, yields the identical outer width in both
     * regimes the host defines (wide column: the cap binds; narrow/embedded:
     * `100% - 2 * clearance` binds). No hard-coded pixel value is involved, so
     * the card follows the composer when the user resizes the column or the
     * window.
     */
    const CSS = `
.dld-dock {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: calc(
    100%
    - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance)
  );
  max-width: var(--dsh-composer-card-max-width);
  margin: 0 auto;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-panel, 12px);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dld-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
}
.dld-title {
  font-weight: 600;
  font-size: 12px;
}
.dld-count {
  color: var(--dsw-alias-label-secondary);
}
.dld-spacer { flex: 1; }
.dld-toggle {
  border: none;
  background: none;
  padding: 2px 6px;
  border-radius: 6px;
  color: var(--dsw-alias-brand-primary);
  font: inherit;
  cursor: pointer;
}
.dld-toggle:hover { background: var(--dsw-alias-bg-layer-1); }
.dld-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dld-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 0;
}
.dld-badge {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dld-badge[data-kind="ban"] { color: var(--dsw-alias-state-error-primary); }
.dld-badge[data-kind="pin"] { color: var(--dsw-alias-brand-primary); }
.dld-badge[data-kind="decision"] { color: var(--dsw-alias-state-warn-primary); }
.dld-text { flex: 1; word-break: break-word; }
.dld-meta {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dld-remove {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: 4px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease;
}
.dld-row:hover .dld-remove,
.dld-remove:focus-visible {
  opacity: 1;
}
.dld-remove:hover {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-error-primary);
}
.dld-remove:disabled {
  cursor: default;
  opacity: 0.5;
}
.dld-remove[data-visible="always"] { opacity: 1; }
.dld-error {
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
}
.dld-row[data-status="superseded"] .dld-text,
.dld-row[data-status="revoked"] .dld-text,
.dld-row[data-status="retracted"] .dld-text {
  text-decoration: line-through;
  color: var(--dsw-alias-label-secondary);
}
.dld-group {
  margin-top: 2px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dld-hint {
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dld-empty { color: var(--dsw-alias-label-secondary); }
`

    /** Install the stylesheet once; return its removal. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-directive-ledger'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    /** Small trash glyph; inherits the row's colour. */
    function IconTrash() {
      return h(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true },
        h('path', { d: 'M4 7h16' }),
        h('path', { d: 'M10 7V5h4v2' }),
        h('path', { d: 'M6 7l1 12h10l1-12' }),
      )
    }

    /** One requirement row. */
    function Row({ item, t, removable, busy, onRemove }) {
      const badge = t(`kind.${item.kind}`)
      return h(
        'li',
        { className: 'dld-row', 'data-status': item.status, 'data-kind': item.kind },
        h('span', { className: 'dld-badge', 'data-kind': item.kind }, badge),
        h('span', { className: 'dld-text' }, item.text),
        h(
          'span',
          { className: 'dld-meta' },
          t('source.turn', { turn: String(item.turn) }),
          // An in-force entry the budget kept out of the prompt must say so;
          // otherwise the panel claims the model was told something it was not.
          item.status === 'active' && item.injected === false ? ' · ' : '',
          item.status === 'active' && item.injected === false ? t('dock.omitted') : '',
        ),
        removable
          ? h('button', {
            type: 'button',
            className: 'dld-remove',
            title: t('dock.remove', { text: item.text }),
            'aria-label': t('dock.remove', { text: item.text }),
            disabled: busy,
            onClick: (event) => {
              event.stopPropagation()
              onRemove(item)
            },
          }, h(IconTrash))
          : null,
      )
    }

    /** POST one removal and surface the host's own refusal text. */
    async function requestRemove(sessionId, directiveId, signal) {
      const response = await fetch(`${API}/drop`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionId, directiveId }),
        signal,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.message || `HTTP ${response.status}`)
      }
      return payload
    }

    /**
     * The dock itself.
     *
     * Collapsed by default: a standing block the user has to scroll past becomes
     * noise, and noise is what gets ignored. The count and the enforceable count
     * stay visible so the plugin is never silently doing something.
     */
    function DirectiveDock(props) {
      const { useProjection, sessionId } = props
      const t = props.t
      const view = useProjection(PROJECTION_KEY)
      const [expanded, setExpanded] = useState(false)
      const [busyId, setBusyId] = useState(null)
      const [error, setError] = useState(null)
      const items = Array.isArray(view?.items) ? view.items : []
      const groups = useMemo(() => ({
        active: items.filter((item) => item.status === 'active'),
        superseded: items.filter((item) => item.status === 'superseded'),
        revoked: items.filter((item) => item.status === 'revoked'),
        retracted: items.filter((item) => item.status === 'retracted'),
      }), [items])
      const enforced = groups.active.filter((item) => item.enforceable).length
      const shown = expanded ? groups.active : groups.active.slice(0, 3)
      const retired = [...groups.superseded, ...groups.revoked, ...groups.retracted]

      const remove = (item) => {
        if (sessionId === undefined || busyId !== null) return
        setBusyId(item.id)
        setError(null)
        requestRemove(sessionId, item.id)
          .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
          .finally(() => setBusyId(null))
      }

      if (items.length === 0) return null

      return h(
        'section',
        { className: 'dld-dock', 'aria-label': t('dock.title') },
        h(
          'div',
          { className: 'dld-head' },
          h('span', { className: 'dld-title' }, t('dock.title')),
          h('span', { className: 'dld-count' }, t('dock.count', { count: String(groups.active.length) })),
          enforced > 0 ? h('span', { className: 'dld-count' }, t('dock.enforced', { count: String(enforced) })) : null,
          h('span', { className: 'dld-spacer' }),
          groups.active.length > 3
            ? h('button', {
              type: 'button',
              className: 'dld-toggle',
              'aria-expanded': expanded,
              onClick: () => setExpanded((value) => !value),
            }, expanded ? t('dock.collapse') : t('dock.expand'))
            : null,
        ),
        groups.active.length === 0
          ? h('span', { className: 'dld-empty' }, t('empty'))
          : h('ul', { className: 'dld-list' }, shown.map((item) => h(Row, {
            key: item.id,
            item,
            t,
            removable: sessionId !== undefined,
            busy: busyId === item.id,
            onRemove: remove,
          }))),
        expanded && retired.length > 0
          ? h(
            'div',
            null,
            h('div', { className: 'dld-group' }, t('group.superseded')),
            h('ul', { className: 'dld-list' }, retired.map((item) => h(Row, { key: item.id, item, t }))),
          )
          : null,
        error === null ? null : h('div', { className: 'dld-error', role: 'alert' }, error),
        expanded ? h('div', { className: 'dld-hint' }, t('hint')) : null,
      )
    }

    // ---------------------------------------------------------------- plugin

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'directive-ledger: dictionaries')
      ctx.effect(() => installStyles(), 'directive-ledger: styles')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        { name: 'conversation.input.dock', id: 'directive-ledger', order: 5, locale: NS },
        (props) => h(DirectiveDock, { ...props, t }),
      ))
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
