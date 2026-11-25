/**
 * session-title-template — Client half.
 *
 * Adds three surfaces to the sidebar: a session-menu group, a title-status icon
 * at the end of each row, and a status section in the row's hover card.
 *
 * Two framework facts shape this file:
 *
 * 1. A profile-installed plugin cannot resolve Harness Client packages, so
 *    React comes from the module table (`require('react')`) and every control
 *    here is written locally. No `@deepseek-ai/...` import is allowed.
 * 2. The command executor resolves its agent through a lookup that only finds
 *    live agents, so `/title refresh` and `/title status` cannot act on a
 *    session nobody has opened. Renaming can: `sessions.using(...)` retains a
 *    reference, which resumes the session, and `SessionFace.rename` is the
 *    Client face that pins it. So the menu hides the live-only entries for cold
 *    rows instead of letting them fail.
 */
window.__ModuleLoader__.load({
  id: '@redheartsecretman/session-title-template',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'sessionTitleTemplate';
    const ICON_SLOT = 'contextMenu.icon';
    const TRAILING_SLOT = 'sidebar.session.row.trailing';
    const HOVER_SLOT = 'sidebar.session.row.hover';

    /**
     * Glyphs with no shipped equivalent, registered under this plugin's keys.
     *
     * The path data is copied verbatim from the host icon set (16px grid,
     * 1.2 stroke), which is the documented way for a plugin to match host
     * artwork without importing the primitives package — a profile-installed
     * plugin cannot resolve it anyway.
     */
    const OWN_ICONS = {
      'session-title-template.refresh': [
        'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1',
        'M14.4999 1.5V5.1H10.8999',
      ],
      'session-title-template.info': ['M8 7V11M8 4.5V5.5'],
    };

    /** Projection key this plugin registers on the Host. */
    const STATE_KEY = 'sessionTitleState';

    /**
     * Read this session's title state from the Session list projection block.
     *
     * The three target slots receive only `{ sessionId }`, but every slot carries
     * `useSessions`, so the list row is the way to reach Host-computed values.
     * An absent key means the Host has not registered the projection (or the
     * row is a cached one without it) — render nothing rather than guess.
     */
    function useTitleState(useSessions, sessionId) {
      return useSessions((state) => {
        const value = state.byId[sessionId]?.projectionValues?.[STATE_KEY];
        return value === null || typeof value !== 'object' ? undefined : value;
      });
    }

    /** Inline glyphs, drawn locally so no icon package is required. */
    function glyph(path, size = 14) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block', flex: 'none' },
      }, ...path.map((d, index) => h('path', { key: index, d })));
    }

    const PAINT = {
      auto: { d: ['M2 8h3l2-4 2 8 2-4h3'], labelKey: 'icon.auto' },
      pinned: { d: ['M4 2v7a3 3 0 0 0 6 0V2', 'M3 2h8', 'M3 14h10'], labelKey: 'icon.pinned' },
      failed: { d: ['M8 2v7', 'M8 12.2v.1'], labelKey: 'icon.fallback' },
    };

    /** The status icon for one row, or null when the Host has said nothing. */
    function TitleStatusIcon({ useSessions, sessionId, t }) {
      const state = useTitleState(useSessions, sessionId);
      // Absent projection means the Host has not registered it for this row
      // (or the row came from a cache without it). Drawing an icon then would
      // assert a title status the plugin cannot know.
      if (state === undefined) return null;
      const kind = state.pinned === true ? 'pinned'
        : state.source === 'provider' ? 'auto'
          : state.source === 'fallback' ? 'failed'
            : undefined;
      if (kind === undefined) return null;
      const paint = PAINT[kind];
      const label = t(paint.labelKey);
      return h('span', {
        title: label, role: 'img', 'aria-label': label,
        style: {
          display: 'inline-flex', alignItems: 'center',
          color: kind === 'failed' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-tertiary)',
          opacity: kind === 'auto' ? 0.65 : 1, marginInlineStart: 4,
        },
      }, glyph(paint.d));
    }

    /**
     * Build the native menu rows for one Session.
     *
     * The four operations live in one submenu beside the built-in entries, so the
     * main menu keeps its length and each row inherits the native icon column,
     * spacing and disabled styling. Icons reuse the shipped `workspace.*` keys
     * rather than shipping near-copies: the icon slot is keyed, and reusing a key
     * the host already draws keeps stroke weight and optical size identical.
     *
     * Pinning goes through the Session reference, which resumes a cold session.
     * The other three go through `/title`, whose executor resolves its agent
     * through a lookup that only finds live agents — so they are offered as
     * disabled with an explanation on a session nobody has opened, instead of
     * failing after a click.
     */
    function titleMenuActions(target, { t, ctx }) {
      const { sessionId, displayTitle } = target;
      const live = (ctx.sessions.retainInfo(sessionId).getSnapshot()?.referenceCount ?? 0) > 0;
      const coldHint = live ? undefined : t('menu.needsOpen');
      const runCommand = async (line) => {
        const result = await ctx.remote.commands.execute(sessionId, line, []);
        if (result.ok === false) throw new Error(result.error.message);
        const outcome = result.value?.result;
        if (outcome === undefined) throw new Error(t('menu.unknownCommand'));
        if (outcome.kind === 'error') throw new Error(outcome.text);
        ctx.contextMenus.notify(String(outcome.text ?? t('menu.done')), true);
      };
      const pin = async () => {
        const result = await ctx.sessions.using(
          sessionId,
          { source: 'sessionTitleTemplate' },
          reference => reference.binding.session.rename(displayTitle),
        );
        if (result.ok === false) throw new Error(result.error.message);
        ctx.contextMenus.notify(t('menu.pinDone'), true);
      };
      return [{
        id: 'title',
        label: t('menu.title'),
        icon: { key: 'workspace.rename' },
        // The submenu is always offered; individual rows carry the reason they
        // are unavailable, which is more discoverable than an empty menu.
        children: [
          {
            id: 'title.refresh',
            label: coldHint === undefined ? t('menu.refresh') : `${t('menu.refresh')}（${coldHint}）`,
            icon: { key: 'session-title-template.refresh' },
            disabled: !live,
            ...(live ? { run: () => runCommand('/title refresh') } : {}),
            failureLabel: t('menu.refreshFailed'),
          },
          {
            id: 'title.pin',
            label: t('menu.pin'),
            icon: { key: 'workspace.pin' },
            run: pin,
            failureLabel: t('menu.pinFailed'),
          },
          {
            id: 'title.auto',
            label: coldHint === undefined ? t('menu.auto') : `${t('menu.auto')}（${coldHint}）`,
            icon: { key: 'workspace.markRead' },
            disabled: !live,
            ...(live ? { run: () => runCommand('/title auto') } : {}),
            failureLabel: t('menu.autoFailed'),
          },
          {
            id: 'title.status',
            label: coldHint === undefined ? t('menu.status') : `${t('menu.status')}（${coldHint}）`,
            icon: { key: 'session-title-template.info' },
            disabled: !live,
            ...(live ? { run: () => runCommand('/title status') } : {}),
            failureLabel: t('menu.statusFailed'),
          },
        ],
      }];
    }

    /** The hover-card section: where the title came from and what last failed. */
    function TitleHover({ useSessions, sessionId, t }) {
      const state = useTitleState(useSessions, sessionId);
      if (state === undefined) return null;
      const source = state.source === 'user' ? t('source.user')
        : state.source === 'provider' ? t('source.provider')
          : state.source === 'fallback' ? t('source.fallback')
            : t('source.unknown');
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        h('div', null, `${t('hover.source')}: ${source}`),
        state.pinned === true ? h('div', null, t('hover.pinned')) : null,
      );
    }

    return {
      inject: ['slots', 'sessions', 'locale', 'remote', 'remote.commands', 'contextMenus'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            'menu.title': '会话标题',
            'menu.refresh': '重新生成标题',
            'menu.pin': '固定当前标题',
            'menu.auto': '恢复自动命名',
            'menu.status': '查看命名状态',
            'menu.needsOpen': '需先打开会话',
            'menu.refreshFailed': '重新生成标题失败',
            'menu.autoFailed': '恢复自动命名失败',
            'menu.statusFailed': '读取命名状态失败',
            'menu.unknownCommand': '未知命令',
            'menu.failed': '操作失败',
            'menu.done': '已完成',
            'menu.pinDone': '会话标题已固定，自动命名不再覆盖。',
            'menu.pinFailed': '固定失败',
            'icon.auto': '标题由插件自动生成',
            'icon.pinned': '标题已手动固定',
            'icon.fallback': '当前为临时回退标题',
            'hover.source': '标题来源',
            'hover.pinned': '已固定，自动命名不再覆盖',
            'source.user': '手动固定',
            'source.provider': '自动生成',
            'source.fallback': '临时回退',
            'source.unknown': '未知',
          },
          en: {
            'menu.title': 'Session title',
            'menu.refresh': 'Regenerate title',
            'menu.pin': 'Pin current title',
            'menu.auto': 'Resume automatic naming',
            'menu.status': 'Show naming status',
            'menu.needsOpen': 'open the session first',
            'menu.refreshFailed': 'Could not regenerate the title',
            'menu.autoFailed': 'Could not resume automatic naming',
            'menu.statusFailed': 'Could not read the naming status',
            'menu.unknownCommand': 'Unknown command',
            'menu.failed': 'The action failed',
            'menu.done': 'Done',
            'menu.pinDone': 'Title pinned; automatic naming will not overwrite it.',
            'menu.pinFailed': 'Could not pin the title',
            'icon.auto': 'Title generated by the plugin',
            'icon.pinned': 'Title pinned manually',
            'icon.fallback': 'Showing a temporary fallback title',
            'hover.source': 'Title source',
            'hover.pinned': 'Pinned; automatic naming will not overwrite it',
            'source.user': 'Pinned manually',
            'source.provider': 'Generated automatically',
            'source.fallback': 'Temporary fallback',
            'source.unknown': 'Unknown',
          },
        }), 'session-title-template: dictionaries');
        const t = ctx.locale.bind(NS);
        // Two glyphs have no shipped equivalent, so they are registered under this
        // plugin's own keys. Their path data is copied from the host icon set, and
        // they are rendered with the host's stroke geometry so they sit in the
        // native icon column without looking foreign.
        ctx.effect(() => {
          const off = [];
          for (const [key, paths] of Object.entries(OWN_ICONS)) {
            off.push(ctx.slots.register({ name: ICON_SLOT, key }, () => glyph(paths)));
          }
          return () => { for (const dispose of off) dispose(); };
        }, 'session-title-template: menu icons');

        // The menu is a native contextMenus contribution, not the legacy
        // `sidebar.workspaces.session.menu.item` slot: the slot renders a bare
        // React row that inherits none of the native row geometry, icon column,
        // separator or submenu behaviour, so its entries read as foreign text
        // between the built-in ones.
        ctx.effect(() => ctx.contextMenus.register({
          id: 'session-title-template.title', target: 'session', order: 400,
          resolve: (target) => titleMenuActions(target, { t, ctx }),
        }), 'session-title-template: session menu');

        ctx.slots.inject(TRAILING_SLOT, () => ctx.slots.register({
          name: TRAILING_SLOT, id: 'session-title-template', order: 50, locale: NS,
        }, (props) => h(TitleStatusIcon, { ...props, t })));

        ctx.slots.inject(HOVER_SLOT, () => ctx.slots.register({
          name: HOVER_SLOT, id: 'session-title-template', order: 50, locale: NS,
        }, (props) => h(TitleHover, { ...props, t })));
      },
    };
  },
});
