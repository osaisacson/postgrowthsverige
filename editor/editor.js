// Obsidian-style live-preview Markdown editor built on CodeMirror 6.
// Bundled to public/editor.js with `npm run build:editor`; exposes window.PGSEditor.
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, placeholder, drawSelection } from '@codemirror/view';
import { EditorState, EditorSelection, RangeSetBuilder } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree, HighlightStyle, syntaxHighlighting, indentOnInput } from '@codemirror/language';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { autocompletion, completionKeymap, closeBrackets } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

const IMG = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

const highlight = HighlightStyle.define([
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--text-faint)' },
  { tag: t.monospace, fontFamily: 'var(--mono)', fontSize: '0.9em', background: 'var(--bg-soft)', borderRadius: '4px' },
  { tag: t.processingInstruction, color: 'var(--text-faint)' },
  { tag: t.quote, color: 'var(--text)' },
  { tag: t.contentSeparator, color: 'var(--text-faint)' },
  { tag: t.list, color: 'var(--text-faint)' },
]);

class ImageWidget extends WidgetType {
  constructor(src, width, alt) {
    super();
    this.src = src;
    this.width = width;
    this.alt = alt;
  }
  eq(o) {
    return o.src === this.src && o.width === this.width;
  }
  toDOM() {
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.className = 'cm-embed-img';
    if (this.width) img.style.width = this.width + 'px';
    return img;
  }
  ignoreEvent() {
    return false;
  }
}
class FileWidget extends WidgetType {
  constructor(name, ok) {
    super();
    this.name = name;
    this.ok = ok;
  }
  eq(o) {
    return o.name === this.name && o.ok === this.ok;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = this.ok ? 'cm-embed-file' : 'cm-embed-missing';
    s.textContent = (this.ok ? '📎 ' : 'Saknad fil: ') + this.name;
    return s;
  }
}
class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const d = document.createElement('span');
    d.className = 'cm-hr';
    return d;
  }
}

const hide = Decoration.replace({});
const lineClass = (c) => Decoration.line({ class: c });
const markClass = (c) => Decoration.mark({ class: c });

function livePreview(opts) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }
      update(u) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || u.transactions.some((tr) => tr.reconfigured))
          this.decorations = this.build(u.view);
      }
      build(view) {
        const { state } = view;
        const active = new Set();
        if (view.hasFocus)
          for (const r of state.selection.ranges) {
            const a = state.doc.lineAt(r.from).number;
            const b = state.doc.lineAt(r.to).number;
            for (let n = a; n <= b; n++) active.add(n);
          }
        const isActive = (pos) => active.has(state.doc.lineAt(pos).number);
        const decos = [];
        const add = (from, to, d) => decos.push(d.range(from, to));

        for (const { from, to } of view.visibleRanges) {
          // Wikilink ranges first, so the Markdown grammar's own link parsing inside [[...]] is ignored.
          const wiki = [];
          {
            const txt = state.doc.sliceString(from, to);
            const r = /!?\[\[[^\]\n]+?\]\]/g;
            let w;
            while ((w = r.exec(txt))) wiki.push([from + w.index, from + w.index + w[0].length]);
          }
          const inWiki = (a, b) => wiki.some(([x, y]) => a < y && b > x);
          syntaxTree(state).iterate({
            from,
            to,
            enter: (node) => {
              const name = node.name;
              const m = /^ATXHeading(\d)$/.exec(name);
              if (m) {
                add(node.from, node.from, lineClass('cm-h cm-h' + m[1]));
                return;
              }
              if (name === 'Blockquote') {
                for (let pos = node.from; pos <= node.to; ) {
                  const line = state.doc.lineAt(pos);
                  add(line.from, line.from, lineClass('cm-quote'));
                  pos = line.to + 1;
                }
                return;
              }
              if (name === 'FencedCode') {
                for (let pos = node.from; pos <= node.to; ) {
                  const line = state.doc.lineAt(pos);
                  add(line.from, line.from, lineClass('cm-codeblock'));
                  pos = line.to + 1;
                }
                return false;
              }
              if ((name === 'Link' || name === 'LinkMark' || name === 'URL' || name === 'LinkLabel') && inWiki(node.from, node.to)) return false;
              const onActive = isActive(node.from);
              if (onActive) return;
              if (name === 'HeaderMark') {
                const next = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
                add(node.from, next, hide);
              } else if (name === 'EmphasisMark' || name === 'StrikethroughMark' || (name === 'CodeMark' && node.node.parent?.name === 'InlineCode')) {
                add(node.from, node.to, hide);
              } else if (name === 'QuoteMark') {
                const next = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
                add(node.from, next, hide);
              } else if (name === 'HorizontalRule') {
                add(node.from, node.to, Decoration.replace({ widget: new HrWidget() }));
              } else if (name === 'Link') {
                // [text](url) -> show only "text" styled as a link
                const marks = [];
                let url = null;
                for (let c = node.node.firstChild; c; c = c.nextSibling) {
                  if (c.name === 'LinkMark') marks.push(c);
                  if (c.name === 'URL') url = c;
                }
                if (marks.length >= 2) {
                  add(marks[0].from, marks[0].to, hide);
                  add(marks[0].to, marks[1].from, markClass('cm-link'));
                  add(marks[1].from, node.to, hide);
                }
              }
            },
          });

          // Obsidian wikilinks and embeds, which the Markdown grammar doesn't know about.
          const text = state.doc.sliceString(from, to);
          const re = /(!?)\[\[([^\]\n]+?)\]\]/g;
          let mm;
          while ((mm = re.exec(text))) {
            const start = from + mm.index;
            const end = start + mm[0].length;
            const inner = mm[2];
            const [target, ...rest] = inner.split('|');
            const alias = rest.join('|');
            const name = target.split('#')[0].split('/').pop().trim();
            if (isActive(start)) {
              add(start, end, markClass('cm-wikilink-raw'));
              continue;
            }
            if (mm[1]) {
              if (IMG.test(name)) {
                const width = /^\d+$/.test(alias.trim()) ? alias.trim() : '';
                add(start, end, Decoration.replace({ widget: new ImageWidget(opts.fileUrl(name), width, name) }));
              } else {
                add(start, end, Decoration.replace({ widget: new FileWidget(name, opts.hasFile(name)) }));
              }
              continue;
            }
            const labelStart = alias ? start + 2 + target.length + 1 : start + 2;
            const labelEnd = end - 2;
            add(start, labelStart, hide);
            add(labelStart, labelEnd, markClass(opts.pageExists(name) ? 'cm-wikilink' : 'cm-wikilink cm-unresolved'));
            add(labelEnd, end, hide);
          }
        }
        decos.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
        const builder = new RangeSetBuilder();
        let lastTo = -1;
        for (const d of decos) {
          // Drop overlapping replacements to keep the RangeSet valid.
          if (d.value.point || d.value.spec?.widget) {
            if (d.from < lastTo) continue;
            lastTo = Math.max(lastTo, d.to);
          }
          builder.add(d.from, d.to, d.value);
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

function wikiCompletions(opts) {
  return (ctx) => {
    const m = ctx.matchBefore(/!?\[\[[^\]\n|]*/);
    if (!m) return null;
    const embed = m.text.startsWith('!');
    const from = m.from + (embed ? 3 : 2);
    const after = ctx.state.doc.sliceString(ctx.pos, ctx.pos + 2);
    const close = after === ']]' ? '' : ']]';
    const items = opts.completions(embed).map((o) => ({
      label: o.value,
      detail: o.hint || '',
      apply: (view, c, f, to) => {
        const insert = o.value + close;
        view.dispatch({
          changes: { from: f, to, insert },
          selection: { anchor: f + o.value.length + 2 },
        });
      },
    }));
    return { from, options: items, validFor: /^[^\]\n|]*$/ };
  };
}

function wrapSel(view, a, b = a) {
  view.dispatch(
    view.state.changeByRange((r) => ({
      changes: [
        { from: r.from, insert: a },
        { from: r.to, insert: b },
      ],
      range: EditorSelection.range(r.from + a.length, r.to + a.length),
    }))
  );
  return true;
}

export function create(parent, opts) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc || '',
      extensions: [
        history(),
        drawSelection(),
        indentOnInput(),
        closeBrackets(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(highlight),
        livePreview(opts),
        autocompletion({ override: [wikiCompletions(opts)], icons: false }),
        placeholder(opts.placeholder || ''),
        keymap.of([
          { key: 'Mod-b', run: (v) => wrapSel(v, '**') },
          { key: 'Mod-i', run: (v) => wrapSel(v, '*') },
          { key: 'Mod-k', run: (v) => wrapSel(v, '[[', ']]') },
          { key: 'Mod-s', run: () => (opts.onSave && opts.onSave(), true), preventDefault: true },
          ...completionKeymap,
          ...historyKeymap,
          indentWithTab,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && opts.onChange) opts.onChange(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          paste(e, v) {
            const files = [...(e.clipboardData?.files || [])];
            if (!files.length || !opts.onFiles) return false;
            e.preventDefault();
            opts.onFiles(files, (text) => insertAtCursor(v, text));
            return true;
          },
          drop(e, v) {
            const files = [...(e.dataTransfer?.files || [])];
            if (!files.length || !opts.onFiles) return false;
            e.preventDefault();
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos != null) v.dispatch({ selection: { anchor: pos } });
            opts.onFiles(files, (text) => insertAtCursor(v, text));
            return true;
          },
        }),
      ],
    }),
  });
  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    insert: (text) => insertAtCursor(view, text),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

function insertAtCursor(view, text) {
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  view.focus();
}

window.PGSEditor = { create };
