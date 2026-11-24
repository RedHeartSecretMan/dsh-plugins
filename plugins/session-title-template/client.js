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
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    const TRAILING_SLOT = 'sidebar.session.row.trailing';
    const HOVER_SLOT = 'sidebar.session.row.hover';

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

    /** Whether this row's session is live, so a command can reach it. */
    function useIsLive(useSessionRetainInfo, sessionId) {
      return useSessionRetainInfo(sessionId, info => (info?.referenceCount ?? 0) > 0);
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

    /** One `menuitem` row. */
    function MenuRow({ onSelect, children, disabled = false }) {
      return h('button', {
        type: 'button', role: 'menuitem', disabled,
        onClick: disabled ? undefined : onSelect,
        style: {
          display: 'block', width: '100%', textAlign: 'start', padding: '6px 12px',
          background: 'none', border: 0, color: disabled ? 'var(--dsw-alias-label-dimmed)' : 'inherit',
          font: 'inherit', cursor: disabled ? 'default' : 'pointer',
        },
      }, children);
    }

    /**
     * The four title actions.
     *
     * `rename` is used for the pin because it reaches cold sessions; the other
     * two go through the `/title` command and are only offered while live.
     */
    function TitleMenu({ sessionId, displayTitle, useSessionRetainInfo, useMenuOpenState, t, ctx }) {
      const live = useIsLive(useSessionRetainInfo, sessionId);
      const [, setMenuOpen] = useMenuOpenState();
      const [note, setNote] = React.useState(undefined);

      /** Run one command and surface its text; commands report failures as text. */
      const runCommand = async (line) => {
        setMenuOpen(false);
        try {
          const result = await ctx.remote.commands.execute(sessionId, line, []);
          // Failure text comes from the Host and is shown verbatim: it names the
          // cause, and the Host never puts prompt or response text in it.
          if (!result.ok) { setNote(result.error.message); return; }
          if (result.value === undefined) { setNote(`${t('menu.unknownCommand')}: ${line}`); return; }
          setNote(result.value.result.text ?? (result.value.result.kind === 'error' ? t('menu.failed') : t('menu.done')));
        } catch (error) {
          setNote(error instanceof Error ? error.message : String(error));
        }
      };

      // Pinning goes through the Session reference, not a command: the command
      // executor only reaches a live agent, while retaining a reference resumes
      // the session. `rename` pins and updates the title projection in place.
      const pin = async () => {
        setMenuOpen(false);
        try {
          const result = await ctx.sessions.using(
            sessionId,
            { source: 'sessionTitleTemplate' },
            reference => reference.binding.session.rename(displayTitle),
          );
          setNote(result.ok ? t('menu.pinDone') : `${t('menu.pinFailed')}: ${result.error.message}`);
        } catch (error) {
          setNote(error instanceof Error ? error.message : String(error));
        }
      };

      return h(React.Fragment, null,
        h(MenuRow, { onSelect: () => { void runCommand('/title refresh'); }, disabled: !live }, t('menu.refresh')),
        h(MenuRow, { onSelect: () => { void pin(); } }, t('menu.pin')),
        h(MenuRow, { onSelect: () => { void runCommand('/title auto'); }, disabled: !live }, t('menu.auto')),
        h(MenuRow, { onSelect: () => { void runCommand('/title status'); }, disabled: !live }, t('menu.status')),
        note === undefined ? null : h('div', {
          role: 'status',
          style: { padding: '4px 12px 6px', whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
        }, note),
      );
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
      inject: ['slots', 'sessions', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            'menu.refresh': '重新生成标题',
            'menu.pin': '固定当前标题',
            'menu.auto': '恢复自动命名',
            'menu.status': '查看命名状态',
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
            'menu.refresh': 'Regenerate title',
            'menu.pin': 'Pin current title',
            'menu.auto': 'Resume automatic naming',
            'menu.status': 'Show naming status',
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

        ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
          name: MENU_SLOT, id: 'session-title-template', order: 400, locale: NS,
        }, (props) => h(TitleMenu, { ...props, t, ctx })));

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
