/* Post-growth Sverige — public site + admin editor. Plain JS, no build step. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- state
  const S = {
    site: window.__SITE__ || null,
    editing: null, // page id being edited
    dirty: false,
    openSections: loadOpen(),
    graphMode: 'local',
  };
  const app = document.getElementById('app');

  // ---------------------------------------------------------------- utils
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs)
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const norm = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  const svg = (paths, extra = '') =>
    el('span', { html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`, style: { display: 'inline-flex' } });
  const ICON = {
    chev: '<path d="m9 6 6 6-6 6"/>',
    dots: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    expand: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
    global: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M7.6 7.6 10.6 16M16.4 7.6 13.4 16M8.2 6h7.6"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    quote: '<path d="M3 21c3 0 7-1 7-8V5H3v7h4c0 3-1 5-4 5"/><path d="M14 21c3 0 7-1 7-8V5h-7v7h4c0 3-1 5-4 5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    hr: '<path d="M3 12h18"/>',
  };
  function iconBtn(icon, title, onclick, cls = '') {
    return el('button', { class: 'icon-btn ' + cls, type: 'button', title, 'aria-label': title, onclick }, svg(ICON[icon]));
  }
  function loadOpen() {
    try { return new Set(JSON.parse(localStorage.getItem('pgs-open') || '[]')); } catch { return new Set(); }
  }
  function saveOpen() {
    try { localStorage.setItem('pgs-open', JSON.stringify([...S.openSections])); } catch {}
  }
  function toast(msg, err) {
    const t = el('div', { class: 'toast' + (err ? ' err' : '') }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), err ? 4500 : 2200);
  }

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: { 'X-PGS': '1' }, credentials: 'same-origin' };
    if (opts.form) init.body = opts.form;
    else if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch('/api/' + path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Något gick fel (' + res.status + ')');
    return data;
  }
  async function reload() {
    S.site = await api('site');
  }

  // ---------------------------------------------------------------- lookups
  const pages = () => S.site.pages;
  const sections = () => S.site.sections;
  const home = () => pages().find((p) => p.is_home) || pages()[0];
  const pageUrl = (p) => (p.is_home ? '/' : '/' + encodeURIComponent(p.slug).replace(/%2F/g, '/'));
  function byName(name) {
    const n = norm(name);
    return pages().find((p) => norm(p.title) === n) || pages().find((p) => norm(p.slug) === n) || null;
  }
  const hasFile = (name) => S.site.files.some((f) => norm(f) === norm(name));
  const fileUrl = (name) => '/files/' + encodeURIComponent(S.site.files.find((f) => norm(f) === norm(name)) || name);
  const isFileName = (name) => /\.(png|jpe?g|gif|webp|svg|bmp|avif|pdf|mp4|webm|mp3|m4a|wav|ogg)$/i.test(name);
  const isImage = (name) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(name);

  function parseTarget(inner) {
    let [target, ...rest] = inner.split('|');
    const alias = rest.join('|').trim();
    let anchor = '';
    const hashAt = target.indexOf('#');
    if (hashAt >= 0) {
      anchor = target.slice(hashAt + 1).trim();
      target = target.slice(0, hashAt);
    }
    target = target.trim();
    const name = target.split('/').pop().replace(/\.md$/i, '').trim();
    return { target, name, alias, anchor };
  }

  // Outgoing links per page, for the graph and backlinks.
  function linkIndex() {
    const out = new Map();
    const ghosts = new Map();
    const re = /(!?)\[\[([^\]\n]+?)\]\]/g;
    for (const p of pages()) {
      const set = new Set();
      const body = stripMeta(p.content);
      let m;
      while ((m = re.exec(body))) {
        const { name } = parseTarget(m[2]);
        if (!name || isFileName(name)) continue;
        const t = byName(name);
        if (t) {
          if (t.id !== p.id) set.add('p' + t.id);
        } else {
          const gid = 'g:' + norm(name);
          ghosts.set(gid, name);
          set.add(gid);
        }
      }
      out.set('p' + p.id, set);
    }
    return { out, ghosts };
  }

  // ---------------------------------------------------------------- markdown
  const R = { toc: [], ids: new Map(), depth: 0 };
  function stripMeta(md) {
    return String(md || '')
      .replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
      .replace(/%%[\s\S]*?%%/g, '');
  }
  function headingId(text) {
    let base = String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rubrik';
    let id = base, n = 1;
    while (R.ids.has(id)) id = `${base}-${n++}`;
    R.ids.set(id, true);
    return id;
  }

  marked.use({
    gfm: true,
    breaks: true,
    extensions: [
      {
        name: 'wikilink',
        level: 'inline',
        start(src) {
          const i = src.search(/!?\[\[/);
          return i < 0 ? undefined : i;
        },
        tokenizer(src) {
          const m = /^(!?)\[\[([^\]\n]+?)\]\]/.exec(src);
          if (m) return { type: 'wikilink', raw: m[0], embed: !!m[1], inner: m[2] };
        },
        renderer(tok) {
          return renderWikilink(tok.inner, tok.embed);
        },
      },
      {
        name: 'highlight',
        level: 'inline',
        start(src) {
          const i = src.indexOf('==');
          return i < 0 ? undefined : i;
        },
        tokenizer(src) {
          const m = /^==(?=\S)([^=\n]+?)==/.exec(src);
          if (m) return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
        },
        renderer(tok) {
          return '<mark>' + this.parser.parseInline(tok.tokens) + '</mark>';
        },
      },
    ],
    renderer: {
      heading(text, level, raw) {
        const id = headingId(raw);
        if (R.depth === 0) R.toc.push({ id, level, text: raw.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/[*_`]/g, '') });
        return `<h${level} id="${id}">${text}</h${level}>\n`;
      },
      link(href, title, text) {
        const ext = /^https?:\/\//i.test(href || '');
        const t = title ? ` title="${esc(title)}"` : '';
        return `<a href="${esc(href || '')}"${t}${ext ? ' class="external" target="_blank" rel="noopener"' : ''}>${text}</a>`;
      },
    },
  });

  function renderWikilink(inner, embed) {
    const { target, name, alias, anchor } = parseTarget(inner);
    if (embed) {
      if (isFileName(name)) {
        if (!hasFile(name)) return `<span class="missing-file">[saknad fil: ${esc(name)}]</span>`;
        const url = fileUrl(name);
        if (isImage(name)) {
          let size = '';
          const m = /^(\d+)(?:x(\d+))?$/.exec(alias);
          if (m) size = ` width="${m[1]}"` + (m[2] ? ` height="${m[2]}"` : '');
          const alt = m ? name : alias || name;
          return `<img src="${url}" alt="${esc(alt)}"${size} loading="lazy">`;
        }
        if (/\.pdf$/i.test(name)) return `<iframe class="pdf-embed" src="${url}" title="${esc(name)}"></iframe><a href="${url}" target="_blank" rel="noopener">${esc(name)}</a>`;
        if (/\.(mp4|webm)$/i.test(name)) return `<video src="${url}" controls style="max-width:100%"></video>`;
        if (/\.(mp3|m4a|wav|ogg)$/i.test(name)) return `<audio src="${url}" controls></audio>`;
      }
      const p = byName(name);
      if (p && R.depth < 1) {
        R.depth++;
        const html = marked.parse(stripMeta(p.content));
        R.depth--;
        return `<div class="note-embed"><a class="note-embed-title internal" href="${pageUrl(p)}">${esc(p.title)}</a>${html}</div>`;
      }
    }
    const label = esc(alias || (anchor && !target ? anchor : inner.split('|')[0].split('/').pop()));
    if (!target && anchor) return `<a class="internal" href="#${esc(headingIdPreview(anchor))}">${label}</a>`;
    if (isFileName(name)) {
      return hasFile(name)
        ? `<a class="internal" href="${fileUrl(name)}" target="_blank" rel="noopener">${label}</a>`
        : `<span class="missing-file">${label}</span>`;
    }
    const p = byName(name);
    if (p) return `<a class="internal" href="${pageUrl(p)}${anchor ? '#' + esc(headingIdPreview(anchor)) : ''}">${label}</a>`;
    const admin = S.site.admin;
    return `<span class="unresolved${admin ? ' can-create' : ''}" data-create="${esc(name)}"${admin ? ' title="Klicka för att skapa sidan"' : ''}>${label}</span>`;
  }
  function headingIdPreview(text) {
    return String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function renderMarkdown(md) {
    R.toc = [];
    R.ids = new Map();
    R.depth = 0;
    const html = marked.parse(stripMeta(md));
    return { html, toc: R.toc.slice() };
  }

  // ---------------------------------------------------------------- routing
  function currentRoute() {
    const path = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ''));
    if (path === 'admin') return { admin: true };
    if (path === 'admin/reset') return { reset: true };
    if (!path) return { page: home() };
    return { page: pages().find((p) => p.slug === path) || byName(path) || null, missing: path };
  }

  async function navigate(url, { replace = false } = {}) {
    if (S.dirty && !(await confirmDlg('Osparade ändringar', 'Du har ändringar som inte är sparade. Lämna sidan ändå?', 'Lämna'))) return;
    S.dirty = false;
    S.editing = null;
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    render();
    const hash = location.hash.slice(1);
    if (hash) document.getElementById(decodeURIComponent(hash))?.scrollIntoView();
    else window.scrollTo(0, 0);
  }
  window.addEventListener('popstate', () => {
    S.editing = null;
    S.dirty = false;
    render();
  });
  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a && a.getAttribute('href') && !a.target && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      const href = a.getAttribute('href');
      if (href.startsWith('/') && !href.startsWith('/files/') && !href.startsWith('//')) {
        e.preventDefault();
        document.body.classList.remove('nav-open');
        const [path, hash] = href.split('#');
        if (path === location.pathname && hash) {
          document.getElementById(decodeURIComponent(hash))?.scrollIntoView({ behavior: 'smooth' });
          history.replaceState(null, '', href);
        } else navigate(href);
        return;
      }
      if (href.startsWith('#')) {
        e.preventDefault();
        document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: 'smooth' });
        history.replaceState(null, '', href);
      }
    }
    const un = e.target.closest('.unresolved.can-create');
    if (un && !e.target.closest('.preview')) createPageFlow(un.dataset.create);
  });

  // ---------------------------------------------------------------- render
  function render() {
    closeMenus();
    if (!S.site) return;
    const route = currentRoute();
    if (route.reset) return renderReset();
    if (route.admin) {
      if (S.site.admin) return navigate('/', { replace: true });
      return renderLogin();
    }
    const page = route.page;
    document.title = page && !page.is_home ? `${page.title} - ${S.site.title}` : S.site.title;
    const editing = page && S.editing === page.id && S.site.admin;

    const layout = el('div', { class: 'layout' + (editing ? ' editing' : '') });
    const topbar = el(
      'div',
      { class: 'topbar' },
      iconBtn('menu', 'Meny', () => document.body.classList.add('nav-open')),
      el('a', { href: '/' }, S.site.title)
    );
    const scrim = el('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') });
    layout.append(renderLeft(page));
    const center = el('main', { class: 'center' });
    const inner = el('div', { class: 'center-inner' });
    center.append(inner);
    const right = el('aside', { class: 'right' });
    layout.append(center, right);

    if (!page) {
      inner.append(el('h1', { class: 'page-title' }, 'Sidan finns inte'), el('p', {}, 'Sidan du letar efter finns inte. ', el('a', { href: '/' }, 'Till startsidan')));
      if (S.site.admin && route.missing) inner.append(el('p', {}, el('button', { class: 'btn primary', onclick: () => createPageFlow(route.missing) }, 'Skapa sidan "' + route.missing + '"')));
    } else if (editing) {
      renderEditor(inner, page);
    } else {
      renderPage(inner, right, page);
    }
    app.replaceChildren(topbar, scrim, layout);
  }

  // ---------- left nav
  function renderLeft(page) {
    const left = el('aside', { class: 'left' });
    left.append(el('a', { class: 'site-title', href: '/' }, S.site.title));
    const nav = el('nav', { class: 'nav', 'aria-label': 'Sektioner' });
    const admin = S.site.admin;

    for (const sec of sections()) {
      const secPages = pages().filter((p) => p.section_id === sec.id && !p.is_home);
      const containsCurrent = page && page.section_id === sec.id;
      const open = S.openSections.has(sec.id) || containsCurrent;
      const box = el('div', { class: 'nav-section' + (open ? ' open' : '') });
      const toggle = el(
        'button',
        {
          class: 'nav-toggle',
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          onclick: () => {
            const isOpen = box.classList.toggle('open');
            toggle.setAttribute('aria-expanded', isOpen);
            if (isOpen) S.openSections.add(sec.id);
            else S.openSections.delete(sec.id);
            saveOpen();
          },
        },
        el('span', { class: 'chev', html: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">${ICON.chev}</svg>` }),
        el('span', {}, sec.name)
      );
      const row = el('div', { class: 'nav-row' }, toggle);
      if (admin) {
        const acts = el(
          'div',
          { class: 'row-actions' },
          iconBtn('plus', 'Ny sida i ' + sec.name, () => {
            box.classList.add('open');
            S.openSections.add(sec.id);
            saveOpen();
            inlineInput(list, 'Namn på sidan', async (title) => {
              const r = await api('pages', { method: 'POST', body: { title, section_id: sec.id } });
              await reload();
              S.editing = r.id;
              history.pushState(null, '', '/' + r.slug);
              render();
            });
          }),
          iconBtn('dots', 'Fler val', (e) => sectionMenu(e.currentTarget, sec, secPages))
        );
        row.append(acts);
      }
      const list = el('div', { class: 'nav-pages' });
      for (const p of secPages) {
        const link = el('a', { class: 'nav-page' + (page && page.id === p.id ? ' active' : ''), href: pageUrl(p) }, p.title);
        const prow = el('div', { class: 'nav-row' }, link);
        if (admin) prow.append(el('div', { class: 'row-actions' }, iconBtn('dots', 'Fler val', (e) => pageMenu(e.currentTarget, p))));
        list.append(prow);
      }
      if (!secPages.length && admin) list.append(el('div', { class: 'nav-empty' }, 'Inga sidor än'));
      box.append(row, list);
      nav.append(box);
    }
    // Top-level pages without a section (other than home)
    for (const p of pages().filter((p) => p.section_id == null && !p.is_home)) {
      const prow = el('div', { class: 'nav-row' }, el('a', { class: 'nav-page' + (page && page.id === p.id ? ' active' : ''), href: pageUrl(p), style: { paddingLeft: '6px' } }, p.title));
      if (admin) prow.append(el('div', { class: 'row-actions' }, iconBtn('dots', 'Fler val', (e) => pageMenu(e.currentTarget, p))));
      nav.append(prow);
    }
    left.append(nav);

    if (admin) {
      const holder = el('div');
      const add = el(
        'button',
        {
          class: 'add-section',
          type: 'button',
          onclick: () =>
            inlineInput(holder, 'Namn på sektionen', async (name) => {
              const r = await api('sections', { method: 'POST', body: { name } });
              S.openSections.add(r.id);
              saveOpen();
              await reload();
              render();
            }),
        },
        svg(ICON.plus, 'width="16" height="16"'),
        'Ny sektion'
      );
      left.append(holder, add);
      left.append(
        el(
          'div',
          { class: 'admin-foot' },
          el('span', { class: 'badge' }, 'Admin'),
          el('button', { type: 'button', onclick: manageAdmins }, 'Administratörer'),
          el('button', { type: 'button', onclick: changePassword }, 'Byt lösenord'),
          el('button', { type: 'button', onclick: siteSettings }, 'Inställningar'),
          el('button', { type: 'button', onclick: logout }, 'Logga ut')
        )
      );
    }
    return left;
  }

  function inlineInput(container, placeholder, onSubmit, initial = '') {
    container.querySelector('.inline-input')?.remove();
    const input = el('input', { class: 'inline-input', placeholder, value: initial });
    let busy = false;
    const done = async (commit) => {
      if (busy) return;
      const v = input.value.trim();
      if (!commit || !v) return input.remove();
      busy = true;
      try {
        await onSubmit(v);
      } catch (err) {
        toast(err.message, true);
        busy = false;
        input.focus();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => setTimeout(() => !busy && done(!!input.value.trim()), 100));
    container.append(input);
    input.focus();
    input.select();
  }

  // ---------- page view
  function renderPage(inner, right, page) {
    const { html, toc } = renderMarkdown(page.content);
    const head = el('div', { class: 'page-head' }, el('h1', { class: 'page-title' }, page.title));
    if (S.site.admin) {
      head.append(
        el(
          'div',
          { class: 'page-tools' },
          el('button', { class: 'btn', type: 'button', onclick: () => startEdit(page) }, svg(ICON.edit, 'width="15" height="15"'), 'Redigera'),
          el('button', { class: 'btn', type: 'button', title: 'Sidinställningar', 'aria-label': 'Sidinställningar', onclick: (e) => pageOptionsMenu(e.currentTarget, page) }, svg(ICON.dots, 'width="16" height="16"'))
        )
      );
    }
    const article = el('article', { class: 'markdown', html });
    inner.append(head, article);

    const { out } = linkIndex();
    if (page.options.backlinks) {
      const back = pages().filter((p) => p.id !== page.id && out.get('p' + p.id)?.has('p' + page.id));
      if (back.length)
        inner.append(el('section', { class: 'backlinks' }, el('h4', {}, 'Länkar hit'), back.map((p) => el('a', { href: pageUrl(p) }, p.title))));
    }

    // Only show the graph when this page links somewhere or is linked to.
    if (graphData(page, 'local').nodes.length > 1) right.append(renderGraphCard(page));
    if (toc.length && page.options.toc !== false) {
      const min = Math.min(...toc.map((t) => t.level));
      const nav = el(
        'nav',
        { class: 'toc', 'aria-label': 'Innehåll' },
        toc.map((t) => el('a', { href: '#' + t.id, 'data-id': t.id, style: { marginLeft: (t.level - min) * 14 + 'px' } }, t.text))
      );
      right.append(nav);
      requestAnimationFrame(() => trackToc(nav, article));
    }
  }

  function trackToc(nav, article) {
    const heads = [...article.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')];
    if (!heads.length) return;
    const update = () => {
      let active = heads[0];
      for (const h of heads) if (h.getBoundingClientRect().top < 120) active = h;
      nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.id === active.id));
    };
    update();
    const onScroll = () => {
      if (!nav.isConnected) return window.removeEventListener('scroll', onScroll);
      update();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // ---------- graph
  function graphData(page, mode) {
    const { out, ghosts } = linkIndex();
    const label = (id) => (id.startsWith('g:') ? ghosts.get(id) : pages().find((p) => 'p' + p.id === id)?.title || id);
    const links = [];
    for (const [src, set] of out) for (const t of set) links.push({ source: src, target: t });
    let ids;
    const cur = page ? 'p' + page.id : null;
    if (mode === 'local' && cur) {
      ids = new Set([cur]);
      for (const l of links) {
        if (l.source === cur) ids.add(l.target);
        if (l.target === cur) ids.add(l.source);
      }
    } else {
      ids = new Set([...pages().map((p) => 'p' + p.id), ...ghosts.keys()]);
    }
    return {
      nodes: [...ids].map((id) => ({ id, label: label(id), ghost: id.startsWith('g:') })),
      links: links.filter((l) => ids.has(l.source) && ids.has(l.target)),
      current: cur,
    };
  }
  function openNode(n) {
    const p = pages().find((p) => 'p' + p.id === n.id);
    if (p) navigate(pageUrl(p));
  }
  function renderGraphCard(page) {
    const card = el('div', { class: 'graph-card' });
    const canvas = el('canvas', { 'aria-label': 'Graf över länkade sidor', role: 'img' });
    let graph;
    const toggle = iconBtn('global', 'Visa hela grafen', () => {
      S.graphMode = S.graphMode === 'local' ? 'global' : 'local';
      toggle.classList.toggle('on', S.graphMode === 'global');
      toggle.title = S.graphMode === 'local' ? 'Visa hela grafen' : 'Visa lokal graf';
      const d = graphData(page, S.graphMode);
      graph.setData(d.nodes, d.links, d.current);
    }, S.graphMode === 'global' ? 'on' : '');
    const tools = el('div', { class: 'graph-tools' }, toggle, iconBtn('expand', 'Förstora grafen', () => openGraphModal(page)));
    card.append(tools, canvas);
    requestAnimationFrame(() => {
      const d = graphData(page, S.graphMode);
      graph = new PGSGraph(canvas, { ...d, onClick: openNode });
    });
    return card;
  }
  function openGraphModal(page) {
    const card = el('div', { class: 'graph-card' });
    const canvas = el('canvas');
    let graph;
    let mode = 'global';
    const toggle = iconBtn('global', 'Visa lokal graf', () => {
      mode = mode === 'local' ? 'global' : 'local';
      toggle.classList.toggle('on', mode === 'global');
      const d = graphData(page, mode);
      graph.setData(d.nodes, d.links, d.current);
    }, 'on');
    const close = () => {
      modal.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => e.key === 'Escape' && close();
    card.append(el('div', { class: 'graph-tools' }, toggle, iconBtn('close', 'Stäng', close)), canvas);
    const modal = el('div', { class: 'graph-modal', onclick: (e) => e.target === modal && close() }, card);
    document.body.append(modal);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => {
      const d = graphData(page, mode);
      graph = new PGSGraph(canvas, {
        ...d,
        labelZoom: 0.4,
        onClick: (n) => {
          close();
          openNode(n);
        },
      });
    });
  }

  // ---------------------------------------------------------------- menus & dialogs
  function closeMenus() {
    document.querySelectorAll('.menu').forEach((m) => m.remove());
  }
  function showMenu(anchor, items) {
    closeMenus();
    const menu = el('div', { class: 'menu', role: 'menu' });
    for (const it of items) {
      if (it === '-') menu.append(el('div', { class: 'sep' }));
      else if (it.label && !it.run) menu.append(el('div', { class: 'label' }, it.label));
      else
        menu.append(
          el(
            'button',
            {
              type: 'button',
              role: it.check !== undefined ? 'menuitemcheckbox' : 'menuitem',
              'aria-checked': it.check !== undefined ? String(!!it.check) : null,
              class: it.danger ? 'danger' : '',
              onclick: () => {
                closeMenus();
                Promise.resolve(it.run()).catch((err) => toast(err.message, true));
              },
            },
            it.check !== undefined ? el('span', { class: 'check' + (it.check ? ' on' : '') }) : null,
            it.text
          )
        );
    }
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
    if (left < 8) left = Math.min(r.left, window.innerWidth - mw - 8);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = top + 'px';
    menu.querySelector('button')?.focus();
    setTimeout(() => {
      const off = (e) => {
        if (!menu.contains(e.target)) {
          menu.remove();
          document.removeEventListener('pointerdown', off);
        }
      };
      document.addEventListener('pointerdown', off);
      menu.addEventListener('keydown', (e) => e.key === 'Escape' && menu.remove());
    });
  }

  function dialog({ title, text, input, select, confirm = 'OK', danger = false }) {
    return new Promise((resolve) => {
      const inp = input ? el('input', { value: input.value || '', placeholder: input.placeholder || '', type: input.type || 'text' }) : null;
      const sel = select ? el('select', {}, select.options.map((o) => el('option', { value: o.value, selected: o.value === select.value }, o.label))) : null;
      const dlg = el('dialog', { class: 'dlg' });
      const form = el(
        'form',
        { method: 'dialog' },
        el('h3', {}, title),
        text ? el('p', {}, text) : null,
        inp,
        sel,
        el(
          'div',
          { class: 'actions' },
          el('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Avbryt'),
          el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), value: 'ok', type: 'submit' }, confirm)
        )
      );
      dlg.append(form);
      dlg.addEventListener('close', () => {
        const ok = dlg.returnValue === 'ok';
        dlg.remove();
        if (!ok) return resolve(null);
        resolve(inp ? inp.value.trim() || null : sel ? sel.value : true);
      });
      document.body.append(dlg);
      dlg.showModal();
      (inp || sel)?.focus();
      inp?.select();
    });
  }
  const confirmDlg = (title, text, confirm, danger) => dialog({ title, text, confirm, danger });

  async function move(list, item, dir, endpoint, extra = {}) {
    const ids = list.map((x) => x.id);
    const i = ids.indexOf(item.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api(endpoint, { method: 'POST', body: { ids, ...extra } });
    await reload();
    render();
  }

  function sectionMenu(anchor, sec, secPages) {
    const all = sections();
    showMenu(anchor, [
      {
        text: 'Byt namn…',
        run: async () => {
          const name = await dialog({ title: 'Byt namn på sektionen', input: { value: sec.name }, confirm: 'Spara' });
          if (!name) return;
          await api('sections/' + sec.id, { method: 'PATCH', body: { name } });
          await reload();
          render();
        },
      },
      { text: 'Flytta upp', run: () => move(all, sec, -1, 'sections/reorder') },
      { text: 'Flytta ner', run: () => move(all, sec, 1, 'sections/reorder') },
      '-',
      {
        text: 'Ta bort sektionen',
        danger: true,
        run: async () => {
          const n = secPages.length;
          const ok = await confirmDlg(
            `Ta bort "${sec.name}"?`,
            n ? `Sektionen och dess ${n} ${n === 1 ? 'sida' : 'sidor'} tas bort för gott.` : 'Sektionen är tom och tas bort.',
            'Ta bort',
            true
          );
          if (!ok) return;
          await api('sections/' + sec.id, { method: 'DELETE' });
          await reload();
          const r = currentRoute();
          if (!r.page) navigate('/', { replace: true });
          else render();
        },
      },
    ]);
  }

  async function renamePage(p) {
    const title = await dialog({ title: 'Byt namn på sidan', text: 'Länkar till sidan uppdateras automatiskt.', input: { value: p.title }, confirm: 'Spara' });
    if (!title || title === p.title) return;
    const r = await api('pages/' + p.id, { method: 'PATCH', body: { title } });
    await reload();
    const cur = currentRoute().page;
    if (!cur || cur.id === p.id) history.replaceState(null, '', p.is_home ? '/' : '/' + r.slug);
    render();
  }
  async function movePageToSection(p) {
    const opts = sections().map((s) => ({ value: String(s.id), label: s.name }));
    if (!opts.length) return toast('Skapa en sektion först', true);
    const v = await dialog({ title: 'Flytta till sektion', select: { options: opts, value: String(p.section_id) }, confirm: 'Flytta' });
    if (!v) return;
    await api('pages/' + p.id, { method: 'PATCH', body: { section_id: parseInt(v, 10) } });
    S.openSections.add(parseInt(v, 10));
    saveOpen();
    await reload();
    render();
  }
  async function deletePage(p) {
    const ok = await confirmDlg(`Ta bort "${p.title}"?`, 'Sidan tas bort för gott. Länkar till den visas som tomma länkar.', 'Ta bort', true);
    if (!ok) return;
    await api('pages/' + p.id, { method: 'DELETE' });
    await reload();
    if (!currentRoute().page) navigate('/', { replace: true });
    else render();
  }
  function pageMenu(anchor, p) {
    const siblings = pages().filter((x) => x.section_id === p.section_id && !x.is_home);
    showMenu(anchor, [
      { text: 'Byt namn…', run: () => renamePage(p) },
      { text: 'Flytta upp', run: () => move(siblings, p, -1, 'pages/reorder', { section_id: p.section_id }) },
      { text: 'Flytta ner', run: () => move(siblings, p, 1, 'pages/reorder', { section_id: p.section_id }) },
      { text: 'Flytta till sektion…', run: () => movePageToSection(p) },
      '-',
      { text: 'Ta bort sidan', danger: true, run: () => deletePage(p) },
    ]);
  }
  function pageOptionsMenu(anchor, p) {
    const setOpt = async (key, val) => {
      await api('pages/' + p.id, { method: 'PATCH', body: { options: { [key]: val } } });
      await reload();
      render();
    };
    const items = [
      { text: 'Redigera', run: () => startEdit(p) },
      '-',
      { text: 'Innehållsförteckning', check: p.options.toc !== false, run: () => setOpt('toc', p.options.toc === false) },
      { text: 'Visa "Länkar hit"', check: !!p.options.backlinks, run: () => setOpt('backlinks', !p.options.backlinks) },
      '-',
      { text: 'Byt namn…', run: () => renamePage(p) },
    ];
    if (!p.is_home) {
      items.push(
        { text: 'Flytta till sektion…', run: () => movePageToSection(p) },
        {
          text: 'Gör till startsida',
          run: async () => {
            const ok = await confirmDlg('Gör till startsida?', `"${p.title}" visas när någon går till startsidan.`, 'Ja');
            if (!ok) return;
            await api('pages/' + p.id + '/home', { method: 'POST' });
            await reload();
            navigate('/', { replace: true });
          },
        },
        '-',
        { text: 'Ta bort sidan', danger: true, run: () => deletePage(p) }
      );
    }
    showMenu(anchor, items);
  }

  async function createPageFlow(title) {
    if (!S.site.admin) return;
    if (!sections().length) return toast('Skapa en sektion först', true);
    const cur = currentRoute().page;
    const v = await dialog({
      title: `Skapa sidan "${title}"`,
      text: 'Välj vilken sektion sidan ska ligga i.',
      select: { options: sections().map((s) => ({ value: String(s.id), label: s.name })), value: String(cur?.section_id ?? sections()[0].id) },
      confirm: 'Skapa',
    });
    if (!v) return;
    const r = await api('pages', { method: 'POST', body: { title, section_id: parseInt(v, 10) } });
    await reload();
    S.editing = r.id;
    history.pushState(null, '', '/' + r.slug);
    render();
  }

  async function siteSettings() {
    let s;
    try {
      s = await api('settings');
    } catch (ex) {
      return toast(ex.message, true);
    }
    const dlg = el('dialog', { class: 'dlg dlg-wide' });
    const field = (label, input, hint) => el('div', { class: 'field' }, el('label', {}, label), input, hint ? el('small', {}, hint) : null);
    const title = el('input', { value: s.site_title, required: true });
    const from = el('input', { type: 'email', value: s.email_from, placeholder: 'asaisacson@gmail.com' });
    const host = el('input', { value: s.smtp_host, placeholder: 't.ex. smtp.gmail.com' });
    const port = el('input', { value: s.smtp_port || '465', placeholder: '465' });
    const user = el('input', { value: s.smtp_user, placeholder: 'inloggningsnamn / e-post', autocomplete: 'off' });
    const pass = el('input', { type: 'password', placeholder: s.smtp_pass_set ? '•••••••• (sparat, lämna tomt för att behålla)' : 'lösenord / app-lösenord', autocomplete: 'new-password' });
    const err = el('div', { class: 'err' });
    const testNote = el('div', { class: 'admin-note' });

    const collect = () => ({
      site_title: title.value,
      email_from: from.value,
      smtp_host: host.value,
      smtp_port: port.value,
      smtp_user: user.value,
      ...(pass.value ? { smtp_pass: pass.value } : {}),
    });
    const save = async () => {
      await api('settings', { method: 'PATCH', body: collect() });
      pass.value = '';
      await reload();
    };

    const testBtn = el(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: async () => {
          testNote.replaceChildren('Sparar och skickar…');
          try {
            await save();
            const r = await api('settings/test-email', { method: 'POST', body: { to: S.site.me } });
            testNote.replaceChildren(el('span', { style: { color: 'var(--accent-hover)' } }, `Testmejl skickat till ${r.to}. Kolla inkorgen (och skräpposten).`));
          } catch (ex) {
            testNote.replaceChildren(el('span', { class: 'err' }, ex.message));
          }
        },
      },
      'Spara och skicka testmejl'
    );
    const form = el(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          try {
            await save();
            render();
            dlg.close();
            toast('Inställningar sparade');
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      el('h3', {}, 'Inställningar'),
      field('Sajtens namn', title, 'Visas överst i menyn och i webbläsarfliken.'),
      el('h4', { class: 'settings-sub' }, 'E-post'),
      el('p', { class: 'settings-intro' }, 'Används för att skicka inbjudningar och återställning av lösenord. Fyll i din e-postleverantörs SMTP-uppgifter.'),
      field('Avsändaradress', from, 'Adressen mejlen skickas från.'),
      field('SMTP-server', host),
      field('Port', port, 'Oftast 465.'),
      field('Användarnamn', user),
      field('Lösenord', pass, 'För Gmail: skapa ett app-lösenord under ditt Google-konto. Lagras i sajtens databas.'),
      testNote,
      err,
      el('div', { class: 'actions' }, testBtn, el('span', { style: { flex: 1 } }), el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Avbryt'), el('button', { class: 'btn primary', type: 'submit' }, 'Spara'))
    );
    dlg.append(el('div', { class: 'dlg-body' }, form));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    title.focus();
  }
  async function logout() {
    if (S.dirty && !(await confirmDlg('Osparade ändringar', 'Logga ut ändå?', 'Logga ut'))) return;
    await api('logout', { method: 'POST' });
    S.dirty = false;
    S.editing = null;
    await reload();
    render();
  }

  // ---------------------------------------------------------------- login
  function authCard(...kids) {
    app.replaceChildren(el('div', { class: 'login-wrap' }, ...kids));
  }

  function renderForgot(prefill = '') {
    document.title = 'Glömt lösenordet - ' + S.site.title;
    const err = el('div', { class: 'err', role: 'alert' });
    const email = el('input', { type: 'email', id: 'email', autocomplete: 'username', required: true, value: prefill });
    const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Skicka länk');
    const form = el(
      'form',
      {
        class: 'login',
        onsubmit: async (e) => {
          e.preventDefault();
          btn.disabled = true;
          err.textContent = '';
          try {
            await api('password/forgot', { method: 'POST', body: { email: email.value } });
            authCard(
              el(
                'div',
                { class: 'login' },
                el('h1', {}, 'Kolla din e-post'),
                el('p', {}, `Om ${email.value} är admin har vi skickat en länk för att välja nytt lösenord. Länken gäller i en timme.`),
                el('a', { class: 'back', href: '/admin' }, '← Tillbaka till inloggningen')
              )
            );
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
          }
        },
      },
      el('h1', {}, 'Glömt lösenordet?'),
      el('p', {}, 'Skriv din e-postadress så skickar vi en länk där du väljer ett nytt lösenord.'),
      el('label', { for: 'email' }, 'E-post'),
      email,
      err,
      btn,
      el('a', { class: 'back', href: '/admin' }, '← Tillbaka till inloggningen')
    );
    authCard(form);
    email.focus();
  }

  async function renderReset() {
    const token = new URLSearchParams(location.search).get('token');
    document.title = 'Välj lösenord - ' + S.site.title;
    let info;
    try {
      info = await api('password/check?token=' + encodeURIComponent(token || ''));
    } catch (ex) {
      authCard(
        el(
          'div',
          { class: 'login' },
          el('h1', {}, 'Länken fungerar inte'),
          el('p', {}, ex.message),
          el('button', { class: 'btn primary', type: 'button', onclick: () => renderForgot() }, 'Be om en ny länk'),
          el('a', { class: 'back', href: '/' }, '← Till sajten')
        )
      );
      return;
    }
    const err = el('div', { class: 'err', role: 'alert' });
    const pass = el('input', { type: 'password', id: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
    const pass2 = el('input', { type: 'password', id: 'password2', autocomplete: 'new-password', required: true, minlength: 8 });
    const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Spara och logga in');
    const form = el(
      'form',
      {
        class: 'login',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          if (pass.value !== pass2.value) return (err.textContent = 'Lösenorden är inte likadana.');
          btn.disabled = true;
          try {
            await api('password/set', { method: 'POST', body: { token, password: pass.value } });
            await reload();
            navigate('/', { replace: true });
            toast(info.purpose === 'invite' ? 'Välkommen! Du är inloggad som admin.' : 'Lösenordet är bytt.');
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
          }
        },
      },
      el('h1', {}, info.purpose === 'invite' ? 'Välkommen!' : 'Välj nytt lösenord'),
      el('p', {}, `${info.email} · ${S.site.title}`),
      el('input', { type: 'email', autocomplete: 'username', value: info.email, style: { display: 'none' }, readonly: true }),
      el('label', { for: 'password' }, 'Lösenord (minst 8 tecken)'),
      pass,
      el('label', { for: 'password2' }, 'Upprepa lösenordet'),
      pass2,
      err,
      btn
    );
    authCard(form);
    pass.focus();
  }

  function renderLogin() {
    document.title = 'Logga in - ' + S.site.title;
    const err = el('div', { class: 'err', role: 'alert' });
    const email = el('input', { type: 'email', id: 'email', autocomplete: 'username', required: true });
    const pass = el('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true });
    const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Logga in');
    const form = el(
      'form',
      {
        class: 'login',
        onsubmit: async (e) => {
          e.preventDefault();
          btn.disabled = true;
          err.textContent = '';
          try {
            await api('login', { method: 'POST', body: { email: email.value, password: pass.value } });
            await reload();
            navigate('/', { replace: true });
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
          }
        },
      },
      el('h1', {}, 'Logga in'),
      el('p', {}, S.site.title + ' · admin'),
      el('label', { for: 'email' }, 'E-post'),
      email,
      el('label', { for: 'password' }, 'Lösenord'),
      pass,
      err,
      btn,
      el('a', { class: 'back', href: '#', onclick: (e) => { e.preventDefault(); renderForgot(email.value); } }, 'Glömt lösenordet?'),
      el('a', { class: 'back', href: '/' }, '← Till sajten')
    );
    authCard(form);
    email.focus();
  }

  // ---------------------------------------------------------------- admins & password
  function showInviteResult(note, r, email, isInvite) {
    note.replaceChildren();
    if (r.sent) {
      note.append(isInvite ? `Inbjudan skickad till ${email}.` : `En återställningslänk är skickad till ${email}.`);
      return;
    }
    const link = el('input', { value: r.link, readonly: true, onclick: (ev) => ev.target.select() });
    note.append(
      el(
        'p',
        {},
        r.warning ? `E-posten kunde inte skickas (${r.warning}). ` : 'Utskick av e-post är inte påslaget än. ',
        `Skicka den här länken till ${email} själv:`
      ),
      link
    );
  }

  async function manageAdmins() {
    let data;
    try {
      data = await api('admins');
    } catch (ex) {
      return toast(ex.message, true);
    }
    const dlg = el('dialog', { class: 'dlg dlg-wide' });
    const list = el('div', { class: 'admin-list' });
    const note = el('div', { class: 'admin-note' });
    const input = el('input', { type: 'email', placeholder: 'namn@exempel.se', 'aria-label': 'E-post till ny admin' });
    const addBtn = el('button', { class: 'btn primary', type: 'submit' }, 'Bjud in');
    const draw = () => {
      list.replaceChildren(
        ...data.admins.map((a) =>
          el(
            'div',
            { class: 'admin-row' },
            el('div', {}, el('div', { class: 'admin-email' }, a.email, a.email === data.me ? el('small', {}, ' (du)') : null), a.pending ? el('small', { class: 'pending' }, 'Inbjuden, har inte valt lösenord än') : null),
            el(
              'div',
              { class: 'admin-actions' },
              el(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  title: a.pending ? 'Skicka inbjudan igen' : 'Skicka en länk för att välja nytt lösenord',
                  onclick: async (e) => {
                    e.target.disabled = true;
                    note.replaceChildren();
                    try {
                      const r = await api('admins/' + encodeURIComponent(a.email) + '/reset', { method: 'POST' });
                      showInviteResult(note, r, a.email, a.pending);
                    } catch (ex) {
                      note.append(el('span', { class: 'err' }, ex.message));
                    }
                    e.target.disabled = false;
                  },
                },
                a.pending ? 'Skicka igen' : 'Återställ lösenord'
              ),
              a.email === data.me
                ? null
                : el(
                    'button',
                    {
                      class: 'btn danger',
                      type: 'button',
                      onclick: async () => {
                        dlg.close();
                        const ok = await confirmDlg(`Ta bort ${a.email}?`, 'Personen kan inte längre logga in som admin.', 'Ta bort', true);
                        if (ok) {
                          try {
                            await api('admins/' + encodeURIComponent(a.email), { method: 'DELETE' });
                            toast('Admin borttagen');
                          } catch (ex) {
                            toast(ex.message, true);
                          }
                        }
                        manageAdmins();
                      },
                    },
                    'Ta bort'
                  )
            )
          )
        )
      );
    };
    draw();
    const form = el(
      'form',
      {
        class: 'admin-add',
        onsubmit: async (e) => {
          e.preventDefault();
          addBtn.disabled = true;
          note.replaceChildren();
          try {
            const email = input.value;
            const r = await api('admins', { method: 'POST', body: { email } });
            data = await api('admins');
            draw();
            showInviteResult(note, r, email, true);
            input.value = '';
          } catch (ex) {
            note.append(el('span', { class: 'err' }, ex.message));
          }
          addBtn.disabled = false;
        },
      },
      input,
      addBtn
    );
    dlg.append(
      el(
        'div',
        { class: 'dlg-body' },
        el('h3', {}, 'Administratörer'),
        el('p', {}, 'Den du bjuder in får ett mejl med en länk för att välja lösenord och instruktioner för hur man redigerar sajten.'),
        list,
        form,
        note,
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Stäng'))
      )
    );
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
  }

  async function changePassword() {
    const dlg = el('dialog', { class: 'dlg' });
    const cur = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Nuvarande lösenord', required: true });
    const p1 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Nytt lösenord (minst 8 tecken)', required: true, minlength: 8 });
    const p2 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Upprepa nytt lösenord', required: true, minlength: 8 });
    const err = el('div', { class: 'err' });
    const form = el(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          if (p1.value !== p2.value) return (err.textContent = 'Lösenorden är inte likadana.');
          try {
            await api('password/change', { method: 'POST', body: { current: cur.value, password: p1.value } });
            dlg.close();
            toast('Lösenordet är bytt');
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      el('h3', {}, 'Byt lösenord'),
      el('input', { type: 'email', autocomplete: 'username', value: S.site.me || '', style: { display: 'none' }, readonly: true }),
      cur,
      p1,
      p2,
      err,
      el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Avbryt'), el('button', { class: 'btn primary', type: 'submit' }, 'Spara'))
    );
    dlg.append(form);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    cur.focus();
  }

  // ---------------------------------------------------------------- editor
  function startEdit(p) {
    S.editing = p.id;
    render();
    window.scrollTo(0, 0);
  }

  function renderEditor(inner, page) {
    const titleInput = el('input', { class: 'title-input', value: page.title, 'aria-label': 'Sidans namn' });
    const state = el('span', { class: 'save-state' }, 'Sparat');
    const doneBtn = el('button', { class: 'btn primary', type: 'button' }, 'Klar');
    const ta = el('textarea', { spellcheck: 'true', 'aria-label': 'Sidans innehåll (Markdown)' });
    ta.value = page.content;
    const preview = el('div', { class: 'preview markdown' });
    const panes = el('div', { class: 'editor-panes show-write' }, ta, preview);
    const fileInput = el('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, style: { display: 'none' } });

    let saveTimer = null;
    let saving = Promise.resolve();
    const setState = (t) => (state.textContent = t);
    const save = () => {
      clearTimeout(saveTimer);
      if (!S.dirty) return saving;
      const content = ta.value;
      setState('Sparar…');
      saving = saving
        .then(() => api('pages/' + page.id, { method: 'PATCH', body: { content } }))
        .then(() => {
          page.content = content;
          if (ta.value === content) {
            S.dirty = false;
            setState('Sparat');
          }
        })
        .catch((err) => {
          setState('Kunde inte spara');
          toast(err.message, true);
        });
      return saving;
    };
    const updatePreview = () => (preview.innerHTML = renderMarkdown(ta.value).html);
    let pv = null;
    ta.addEventListener('input', () => {
      S.dirty = true;
      setState('Osparat');
      clearTimeout(pv);
      pv = setTimeout(updatePreview, 120);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 1500);
      autocomplete.update();
    });
    ta.addEventListener('keydown', (e) => {
      if (autocomplete.key(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 's') {
        e.preventDefault();
        save();
      } else if (mod && e.key === 'b') {
        e.preventDefault();
        wrap('**', '**');
      } else if (mod && e.key === 'i') {
        e.preventDefault();
        wrap('*', '*');
      } else if (mod && e.key === 'k') {
        e.preventDefault();
        wrap('[[', ']]');
      }
    });
    ta.addEventListener('blur', () => setTimeout(() => autocomplete.close(), 150));
    ta.addEventListener('click', () => autocomplete.update());

    const renameFromInput = async () => {
      const t = titleInput.value.trim();
      if (!t) return (titleInput.value = page.title);
      if (t === page.title) return;
      try {
        await save();
        const r = await api('pages/' + page.id, { method: 'PATCH', body: { title: t } });
        await reload();
        page.title = t;
        history.replaceState(null, '', page.is_home ? '/' : '/' + r.slug);
        const fresh = pages().find((p) => p.id === page.id);
        ta.value = fresh.content; // links inside this page may have been rewritten
        page.content = fresh.content;
        document.querySelector('.left').replaceWith(renderLeft(fresh));
        toast('Namnet är ändrat');
      } catch (err) {
        toast(err.message, true);
      }
    };
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        ta.focus();
      }
    });
    titleInput.addEventListener('change', renameFromInput);

    doneBtn.addEventListener('click', async () => {
      await save();
      if (S.dirty) return;
      S.editing = null;
      await reload().catch(() => {});
      render();
    });

    function insert(text, selectFrom, selectTo) {
      ta.focus();
      const ok = document.execCommand && document.execCommand('insertText', false, text);
      if (!ok) {
        ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
      if (selectFrom != null) {
        const end = ta.selectionEnd;
        ta.setSelectionRange(end - text.length + selectFrom, end - text.length + selectTo);
      }
    }
    function wrap(a, b) {
      const s = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      insert(a + s + b, a.length, a.length + s.length);
      if (a === '[[') autocomplete.update();
    }
    function linePrefix(prefix) {
      const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      ta.setSelectionRange(start, start);
      insert(prefix);
    }
    async function uploadAndInsert(files) {
      for (const f of files) {
        try {
          setState('Laddar upp…');
          const name = await uploadFile(f);
          insert(`![[${name}]]\n`);
        } catch (err) {
          toast(err.message, true);
          setState('Osparat');
        }
      }
    }
    fileInput.addEventListener('change', () => {
      uploadAndInsert([...fileInput.files]);
      fileInput.value = '';
    });
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) {
        e.preventDefault();
        uploadAndInsert(files);
      }
    });
    ta.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        ta.classList.add('drop-hint');
      }
    });
    ta.addEventListener('dragleave', () => ta.classList.remove('drop-hint'));
    ta.addEventListener('drop', (e) => {
      ta.classList.remove('drop-hint');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) {
        e.preventDefault();
        uploadAndInsert(files);
      }
    });

    const tb = (icon, title, fn, label) =>
      el('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick: fn }, label ? label : svg(ICON[icon]));
    const tabWrite = el('button', { class: 'btn', type: 'button', onclick: () => (panes.className = 'editor-panes show-write') }, 'Skriv');
    const tabPrev = el('button', { class: 'btn', type: 'button', onclick: () => { updatePreview(); panes.className = 'editor-panes show-preview'; } }, 'Förhandsvisa');
    const toolbar = el(
      'div',
      { class: 'toolbar' },
      tb(null, 'Fet (Ctrl/Cmd+B)', () => wrap('**', '**'), 'B'),
      tb(null, 'Kursiv (Ctrl/Cmd+I)', () => wrap('*', '*'), el('i', {}, 'I')),
      tb(null, 'Rubrik', () => linePrefix('## '), 'H2'),
      tb(null, 'Underrubrik', () => linePrefix('### '), 'H3'),
      tb('link', 'Länk till sida [[ ]] (Ctrl/Cmd+K)', () => wrap('[[', ']]')),
      tb('quote', 'Citat', () => linePrefix('> ')),
      tb('list', 'Lista', () => linePrefix('- ')),
      tb('hr', 'Avdelare', () => insert('\n---\n')),
      tb('image', 'Ladda upp bild eller PDF', () => fileInput.click()),
      el('span', { class: 'spacer' }),
      el('span', { class: 'tabs' }, tabWrite, tabPrev)
    );

    inner.append(
      el('div', { class: 'editor-head' }, titleInput, state, doneBtn),
      toolbar,
      panes,
      fileInput,
      el(
        'div',
        { class: 'hint', html: 'Skriv <code>[[</code> för att länka till en sida. Dra in eller klistra in bilder för att ladda upp dem. Sparas automatiskt.' }
      )
    );
    const autocomplete = makeAutocomplete(ta, page);
    updatePreview();
    setTimeout(() => ta.focus(), 0);
  }

  async function uploadFile(file) {
    let f = file;
    let name = file.name || 'fil';
    if (/^image\.(png|jpe?g|gif|webp)$/i.test(name) || !file.name) {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      name = `Pasted image ${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
    }
    if (/^image\/(jpeg|png|webp)$/.test(file.type) && file.size > 2.5e6) {
      const shrunk = await shrinkImage(file);
      if (shrunk) {
        f = shrunk;
        name = name.replace(/\.[^.]+$/, '') + '.webp';
      }
    }
    if (f.size > 25e6) throw new Error('Filen är för stor (max 25 MB)');
    const form = new FormData();
    form.append('file', f, name);
    form.append('name', name);
    const r = await api('files', { method: 'POST', form });
    if (!S.site.files.includes(r.name)) S.site.files.push(r.name);
    return r.name;
  }
  function shrinkImage(file) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const max = 2400;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        c.toBlob((b) => resolve(b && b.size < file.size ? b : null), 'image/webp', 0.88);
      };
      img.onerror = () => resolve(null);
      img.src = URL.createObjectURL(file);
    });
  }

  // [[ autocomplete
  function makeAutocomplete(ta, page) {
    let box = null, items = [], sel = 0, ctx = null;
    function context() {
      const pos = ta.selectionStart;
      if (pos !== ta.selectionEnd) return null;
      const before = ta.value.slice(0, pos);
      const m = /(!?)\[\[([^\]\n[]*)$/.exec(before);
      if (!m) return null;
      const q = m[2];
      if (q.includes('|')) return null;
      return { embed: !!m[1], query: q, start: pos - q.length };
    }
    function options(c) {
      const q = norm(c.query.split('#')[0].split('/').pop());
      const pg = pages().filter((p) => p.id !== page.id).map((p) => ({ value: p.title, hint: sections().find((s) => s.id === p.section_id)?.name || '' }));
      const fl = S.site.files.map((f) => ({ value: f, hint: 'fil' }));
      const all = c.embed ? [...fl, ...pg] : [...pg, ...fl];
      const scored = all
        .map((o) => {
          const v = norm(o.value);
          const i = v.indexOf(q);
          return { o, s: q === '' ? 1 : v.startsWith(q) ? 0 : i >= 0 ? 1 : -1 };
        })
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s);
      return scored.slice(0, 12).map((x) => x.o);
    }
    function close() {
      box?.remove();
      box = null;
      ctx = null;
    }
    function pick(i) {
      const o = items[i];
      if (!o || !ctx) return;
      const after = ta.value.slice(ta.selectionStart);
      const closing = after.startsWith(']]') ? '' : ']]';
      ta.setSelectionRange(ctx.start, ta.selectionStart);
      const text = o.value + closing;
      const ok = document.execCommand && document.execCommand('insertText', false, text);
      if (!ok) {
        ta.setRangeText(text, ctx.start, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
      if (!closing) ta.setSelectionRange(ta.selectionStart + 2, ta.selectionStart + 2);
      close();
    }
    function draw() {
      box.replaceChildren(
        ...items.map((o, i) =>
          el(
            'div',
            { class: i === sel ? 'sel' : '', onmousedown: (e) => { e.preventDefault(); pick(i); } },
            o.value,
            o.hint ? el('small', {}, o.hint) : null
          )
        )
      );
      box.children[sel]?.scrollIntoView({ block: 'nearest' });
    }
    function update() {
      ctx = context();
      if (!ctx) return close();
      items = options(ctx);
      if (!items.length) return close();
      sel = 0;
      if (!box) {
        box = el('div', { class: 'autocomplete', role: 'listbox' });
        document.body.append(box);
      }
      const c = caretXY(ta);
      box.style.left = Math.min(c.x, window.innerWidth - 300) + 'px';
      box.style.top = c.y + 22 + 'px';
      draw();
      const r = box.getBoundingClientRect();
      if (r.bottom > window.innerHeight - 8) box.style.top = c.y - r.height - 4 + 'px';
    }
    function key(e) {
      if (!box) return false;
      if (e.key === 'ArrowDown') sel = (sel + 1) % items.length;
      else if (e.key === 'ArrowUp') sel = (sel - 1 + items.length) % items.length;
      else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(sel);
        return true;
      } else if (e.key === 'Escape') {
        close();
        e.preventDefault();
        return true;
      } else return false;
      e.preventDefault();
      draw();
      return true;
    }
    return { update, key, close };
  }

  // Caret position in viewport coordinates, via a mirror element.
  function caretXY(ta) {
    const cs = getComputedStyle(ta);
    const m = document.createElement('div');
    for (const p of ['boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'tabSize'])
      m.style[p] = cs[p];
    Object.assign(m.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '-9999px' });
    m.textContent = ta.value.slice(0, ta.selectionStart);
    const span = document.createElement('span');
    span.textContent = '​';
    m.append(span);
    document.body.append(m);
    const r = ta.getBoundingClientRect();
    const x = r.left + span.offsetLeft - ta.scrollLeft;
    const y = r.top + span.offsetTop - ta.scrollTop;
    m.remove();
    return { x, y };
  }

  // ---------------------------------------------------------------- boot
  (async function boot() {
    if (!S.site) {
      try {
        await reload();
      } catch (err) {
        app.textContent = 'Kunde inte ladda sidan.';
        return;
      }
    }
    render();
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  })();
})();
