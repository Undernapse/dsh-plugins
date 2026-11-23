/**
 * Browser half of the SearXNG plugin: a `web_search` tool row that shows the
 * sites a search used, one favicon per site, and how many distinct sites the
 * result cites. It shadows the shipped `web_search` row through the keyed
 * `tool.call.toolview` slot; `web_fetch` keeps its shipped row.
 *
 * A keyed slot accepts one entry per key at each priority, and the lowest
 * priority renders. `web-toolview` already registers `web_search` at priority
 * 0, so this row registers below it (negative priority) to take its place.
 * Reusing priority 0 fails the registration instead of shadowing it.
 *
 * The module is loaded by the Web client's module loader; React comes from the
 * loader's module table. Styles are component-local and use only host theme
 * tokens, so the row follows light/dark themes and the font-size preference.
 */
window.__ModuleLoader__.load({
  id: '@undernapse/dsh-web-search-searxng',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace for this row. */
    const NS = 'web-search-searxng';

    /**
     * Slot priority of this row. The shipped `web_search` row sits at 0 and the
     * lowest priority renders, so a negative value shadows it.
     */
    const TOOLVIEW_PRIORITY = -1;

    /** Labels used when the locale seat has not delivered a dictionary yet. */
    const FALLBACK = {
      title: 'Web search',
      searching: 'Searching…',
      preparing: 'Preparing search',
      failed: 'Search failed',
      site: 'site',
      sites: 'sites',
      sources: 'sources',
      noSites: 'No sites returned',
      truncated: 'Showing the first results',
      inspect: 'Inspect',
    };

    const DICTIONARIES = {
      en: FALLBACK,
      zh: {
        title: '网页搜索',
        searching: '正在搜索…',
        preparing: '正在准备搜索',
        failed: '搜索失败',
        site: '个站点',
        sites: '个站点',
        sources: '条来源',
        noSites: '没有返回站点',
        truncated: '仅显示前面的结果',
        inspect: '检查',
      },
    };

    /** At most this many site favicons are shown in the collapsed row. */
    const MAX_ROW_ICONS = 5;

    const CSS = `
.dsh-sx-root{display:flex;flex-direction:column;width:100%;min-width:0}
.dsh-sx-header{display:flex;align-items:center;min-width:0}
.dsh-sx-row{flex:1 1 auto;position:relative;overflow:hidden;display:flex;align-items:center;height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;color:var(--dsw-alias-label-tertiary);transition:color .1s ease;background:none;border:0;padding:0;text-align:left;font:inherit;width:100%}
.dsh-sx-row[data-expandable]{cursor:pointer}
@media(hover:hover){.dsh-sx-row:hover{color:var(--dsw-alias-label-secondary)}}
.dsh-sx-leading{flex:none;width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));display:inline-flex;align-items:center;justify-content:center;margin-right:6px}
.dsh-sx-title{flex:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit}
.dsh-sx-sep{flex:none;width:2px;height:2px;border-radius:1px;margin:0 8px;background:var(--dsw-alias-label-caption)}
.dsh-sx-summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.dsh-sx-root[data-state=error] .dsh-sx-summary{color:var(--dsw-alias-state-error-primary)}
.dsh-sx-root[data-state=stopped] .dsh-sx-summary{color:var(--dsw-alias-state-warn-label)}
.dsh-sx-sites{display:flex;align-items:center;flex:none;margin-left:8px}
.dsh-sx-fav{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;overflow:hidden;border-radius:4px;background:var(--dsw-alias-markdown-code-block);box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base);margin-left:-4px}
.dsh-sx-fav:first-child{margin-left:0}
.dsh-sx-fav-letter{font-weight:600;line-height:1;color:var(--dsw-alias-label-secondary)}
.dsh-sx-fav-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:var(--dsw-alias-bg-base)}
.dsh-sx-count{flex:none;margin-left:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dsh-sx-chevron{flex:none;display:inline-flex;margin-left:6px;color:var(--dsw-alias-label-caption);transition:transform .1s ease}
.dsh-sx-chevron[data-open]{transform:rotate(180deg)}
.dsh-sx-body{margin:4px 0 4px 4px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);max-height:320px;overflow:auto}
.dsh-sx-body-head{padding:8px 12px 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-sx-answer{padding:10px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);white-space:pre-wrap;word-break:break-word}
.dsh-sx-group{padding:8px 12px;border-top:0.5px solid var(--dsw-alias-border-l1)}
.dsh-sx-group:first-of-type{border-top:none}
.dsh-sx-group-head{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-sx-group-head .dsh-sx-fav{margin-left:0;box-shadow:none}
.dsh-sx-domain{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sx-source{display:block;padding:4px 0 4px 22px;text-decoration:none;color:var(--dsw-alias-label-primary)}
@media(hover:hover){.dsh-sx-source:hover .dsh-sx-source-title{text-decoration:underline}}
.dsh-sx-source-title{display:block;font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sx-snippet{display:-webkit-box;margin-top:2px;overflow:hidden;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dsh-sx-date{display:block;margin-top:2px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-caption)}
.dsh-sx-empty,.dsh-sx-truncated{padding:8px 12px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13)}
.dsh-sx-error{padding:8px 12px;color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xs-13);white-space:pre-wrap;word-break:break-word}
.dsh-sx-inspect{display:inline-flex;align-items:center;margin:0 0 8px 12px;padding:2px 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer}
.dsh-sx-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(prefers-reduced-motion:reduce){.dsh-sx-row,.dsh-sx-chevron{transition:none}}
`;

    /** Narrow a value to a non-array object. */
    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /** Parse the recorded call arguments, tolerating preparation and malformed JSON. */
    function parseArgs(block) {
      const done = isRecord(block) && 'kind' in block;
      const raw = done ? block.call?.argsRaw : block?.phase === 'start' ? block.argsRaw : undefined;
      if (typeof raw !== 'string' || raw.length === 0) return undefined;
      try {
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }

    /** Join the text blocks of one result. */
    function resultText(content) {
      if (!Array.isArray(content)) return undefined;
      const text = content
        .filter((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim();
      return text.length === 0 ? undefined : text;
    }

    /** First non-empty line of a message. */
    function firstLine(value) {
      if (typeof value !== 'string') return undefined;
      const line = value.split('\n').map((part) => part.trim()).find((part) => part.length > 0);
      return line;
    }

    /** Accept only absolute HTTP(S) source URLs. */
    function safeUrl(value) {
      if (typeof value !== 'string') return undefined;
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
      } catch {
        return undefined;
      }
    }

    /** Display domain for a source URL; `www.` is dropped for readability. */
    function domainOf(value) {
      const url = safeUrl(value);
      if (url === undefined) return undefined;
      try {
        return new URL(url).hostname.replace(/^www\./i, '');
      } catch {
        return undefined;
      }
    }

    /** Map the persisted `meta.sources` payload to the fields this row uses. */
    function readSources(value) {
      if (!Array.isArray(value)) return [];
      const sources = [];
      for (const source of value) {
        if (!isRecord(source)) continue;
        const url = safeUrl(source.url);
        if (url === undefined) continue;
        sources.push({
          url,
          ...(typeof source.title === 'string' && source.title.length > 0 ? { title: source.title } : {}),
          ...(typeof source.snippet === 'string' && source.snippet.length > 0 ? { snippet: source.snippet } : {}),
          ...(typeof source.publishedAt === 'string' && source.publishedAt.length > 0
            ? { publishedAt: source.publishedAt }
            : {}),
        });
      }
      return sources;
    }

    /** Group sources by display domain, preserving the provider's order. */
    function groupSites(sources) {
      const groups = new Map();
      for (const source of sources) {
        const domain = domainOf(source.url);
        if (domain === undefined) continue;
        const group = groups.get(domain) ?? { domain, sources: [] };
        group.sources.push(source);
        groups.set(domain, group);
      }
      return [...groups.values()];
    }

    /** Derive the row model from preparing, running, or settled block data. */
    function readBlock(block) {
      const done = isRecord(block) && 'kind' in block;
      const state = !done
        ? block?.phase === 'preparing' ? 'preparing' : 'running'
        : block.isError ? 'error'
          : isRecord(block.meta) && block.meta.stopped === true ? 'stopped' : 'ok';
      const args = parseArgs(block);
      const queries = Array.isArray(args?.queries)
        ? args.queries.filter((query) => typeof query === 'string' && query.trim().length > 0).map((query) => query.trim())
        : [];
      const meta = done && isRecord(block.meta) ? block.meta : undefined;
      const subcall = isRecord(block) && typeof block.parentCallId === 'string' && block.parentCallId.length > 0;
      const sources = state === 'ok' && !subcall ? readSources(meta?.sources) : [];
      const sites = groupSites(sources);
      const output = done ? resultText(block.content) : undefined;
      const errorDetail = isRecord(block.error)
        ? typeof block.error.reason === 'string' ? block.error.reason
          : typeof block.error.code === 'string' ? block.error.code : undefined
        : undefined;
      const error = state === 'error' || state === 'stopped'
        ? firstLine(typeof block.error?.message === 'string' ? block.error.message : errorDetail)
          ?? firstLine(output)
          ?? undefined
        : undefined;
      return {
        state,
        queries,
        sources,
        sites,
        output,
        error,
        answer: typeof meta?.answer === 'string' && meta.answer.length > 0 ? meta.answer : undefined,
        truncated: meta?.truncated === true,
        expandable: done && !subcall && state !== 'preparing' && state !== 'running',
      };
    }

    /** Inline search glyph. */
    function searchIcon() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        'aria-hidden': true,
      }, h('circle', { cx: 10.5, cy: 10.5, r: 6.5 }), h('path', { d: 'm19 19-4.2-4.2' }));
    }

    /** Inline disclosure chevron. */
    function chevron(open) {
      return h('svg', {
        width: 12,
        height: 12,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: open ? 'm6 15 6-6 6 6' : 'm9 6 6 6-6 6' }));
    }

    /**
     * One site icon: the site's favicon layered over a letter fallback. The
     * fallback stays visible until the image decodes, and remains if the site
     * has no favicon or the browser refuses the request.
     */
    function siteIcon(domain, size) {
      const letter = (domain[0] ?? '?').toUpperCase();
      return h('span', {
        className: 'dsh-sx-fav',
        style: { width: `${size}px`, height: `${size}px` },
        title: domain,
        'aria-hidden': true,
      },
        h('span', { className: 'dsh-sx-fav-letter', style: { fontSize: `${Math.max(8, Math.round(size * 0.58))}px` } }, letter),
        h('img', {
          className: 'dsh-sx-fav-img',
          src: `https://${domain}/favicon.ico`,
          width: size,
          height: size,
          alt: '',
          loading: 'lazy',
          decoding: 'async',
          referrerPolicy: 'no-referrer',
          onError: (event) => {
            const image = event?.currentTarget;
            if (image !== undefined && image !== null) image.style.display = 'none';
          },
        }),
      );
    }

    /** The `web_search` conversation row. */
    function WebSearchStatusRow(props) {
      const { block, useDisclosure, t, inspect } = props;
      const disclosure = typeof useDisclosure === 'function'
        ? useDisclosure()
        : { expanded: false, toggle() {} };
      const data = readBlock(block);
      const open = disclosure.expanded === true && data.expandable;
      const translate = (key) => {
        try {
          const value = typeof t === 'function' ? t(key) : undefined;
          return typeof value === 'string' && value.length > 0 ? value : FALLBACK[key] ?? key;
        } catch {
          return FALLBACK[key] ?? key;
        }
      };
      const summary = data.error ?? (data.queries.length > 0
        ? data.queries.join(', ')
        : data.state === 'preparing' ? translate('preparing')
          : data.state === 'running' ? translate('searching')
            : '');
      const countLabel = data.sites.length === 1 ? translate('site') : translate('sites');
      const expandable = data.expandable;
      const toggle = (event) => {
        if (event !== undefined && event !== null) event.stopPropagation();
        disclosure.toggle();
      };
      const onKeyDown = (event) => {
        if (event?.key !== 'Enter' && event?.key !== ' ') return;
        event.preventDefault();
        disclosure.toggle();
      };
      const status = data.state === 'preparing' ? translate('preparing')
        : data.state === 'running' ? translate('searching')
          : data.state === 'error' || data.state === 'stopped' ? translate('failed')
            : null;

      const body = open ? h('div', { className: 'dsh-sx-body' },
        data.answer !== undefined ? h('div', { className: 'dsh-sx-answer' }, data.answer) : null,
        data.error !== undefined
          ? h('div', { className: 'dsh-sx-error' }, data.output ?? data.error)
          : data.sites.length === 0
            ? h('div', { className: 'dsh-sx-empty' }, translate('noSites'))
            : h(React.Fragment, null,
              h('div', { className: 'dsh-sx-body-head' },
                `${data.sites.length} ${countLabel} · ${data.sources.length} ${translate('sources')}`),
              ...data.sites.map((site) => h('div', { className: 'dsh-sx-group', key: site.domain },
                h('div', { className: 'dsh-sx-group-head' },
                  siteIcon(site.domain, 16),
                  h('span', { className: 'dsh-sx-domain', title: site.domain }, site.domain),
                ),
                ...site.sources.map((source, index) => h('a', {
                  className: 'dsh-sx-source',
                  key: `${source.url}-${index}`,
                  href: source.url,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  title: source.url,
                },
                  h('span', { className: 'dsh-sx-source-title' }, source.title ?? source.url),
                  source.snippet !== undefined ? h('span', { className: 'dsh-sx-snippet' }, source.snippet) : null,
                  source.publishedAt !== undefined ? h('span', { className: 'dsh-sx-date' }, source.publishedAt) : null,
                )),
              )),
            ),
        data.truncated ? h('div', { className: 'dsh-sx-truncated' }, translate('truncated')) : null,
        inspect !== undefined ? h('button', {
          type: 'button',
          className: 'dsh-sx-inspect',
          onClick: (event) => {
            event.stopPropagation();
            inspect();
          },
        }, translate('inspect')) : null,
      ) : null;

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('div', {
          className: 'dsh-sx-root',
          'data-tool': 'web_search',
          'data-state': data.state,
          ...(open ? { 'data-open': true } : {}),
        },
          status !== null ? h('span', { className: 'dsh-sx-sr' }, status) : null,
          h('div', { className: 'dsh-sx-header', 'data-disclosure-header': true },
            h('div', {
              className: 'dsh-sx-row',
              'data-disclosure-row': true,
              role: expandable ? 'button' : undefined,
              tabIndex: expandable ? 0 : undefined,
              'aria-expanded': expandable ? open : undefined,
              ...(expandable ? { 'data-expandable': true, onClick: toggle, onKeyDown } : {}),
            },
              h('span', { className: 'dsh-sx-leading' }, searchIcon()),
              h('span', { className: 'dsh-sx-title' }, translate('title')),
              summary.length > 0 ? h('span', { className: 'dsh-sx-sep' }) : null,
              summary.length > 0 ? h('span', { className: 'dsh-sx-summary' }, summary) : null,
              data.sites.length > 0 ? h('span', { className: 'dsh-sx-sites' },
                ...data.sites.slice(0, MAX_ROW_ICONS).map((site) => h(React.Fragment, { key: site.domain }, siteIcon(site.domain, 14))),
                h('span', { className: 'dsh-sx-count' }, `${data.sites.length} ${countLabel}`),
              ) : null,
              expandable ? h('span', { className: 'dsh-sx-chevron', ...(open ? { 'data-open': true } : {}) }, chevron(open)) : null,
            ),
          ),
          body,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, DICTIONARIES),
          'web-search-searxng: locale dictionaries',
        );
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'web_search',
          priority: TOOLVIEW_PRIORITY,
          locale: NS,
        }, WebSearchStatusRow));
      },
    };
  },
});
