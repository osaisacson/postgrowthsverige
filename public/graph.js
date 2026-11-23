/* A small Obsidian-style force graph on canvas. No dependencies. */
(function () {
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  class Graph {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.onClick = opts.onClick || (() => {});
      this.t = { x: 0, y: 0, k: 1 };
      this.hover = null;
      this.drag = null;
      this.alpha = 1;
      this.running = false;
      this.labelZoom = opts.labelZoom || 0.55;
      this.bindEvents();
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas.parentElement);
      this.resize();
      this.setData(opts.nodes, opts.links, opts.current);
    }

    setData(nodes, links, current) {
      const old = new Map((this.nodes || []).map((n) => [n.id, n]));
      this.current = current;
      this.nodes = nodes.map((n, i) => {
        const o = old.get(n.id);
        const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
        const r = n.id === current ? 0 : 40 + Math.random() * 60;
        return Object.assign({}, n, {
          x: o ? o.x : Math.cos(a) * r,
          y: o ? o.y : Math.sin(a) * r,
          vx: 0,
          vy: 0,
        });
      });
      const byId = new Map(this.nodes.map((n) => [n.id, n]));
      this.links = links.map((l) => ({ source: byId.get(l.source), target: byId.get(l.target) })).filter((l) => l.source && l.target);
      this.degree = new Map();
      this.neighbors = new Map(this.nodes.map((n) => [n.id, new Set()]));
      for (const l of this.links) {
        this.degree.set(l.source.id, (this.degree.get(l.source.id) || 0) + 1);
        this.degree.set(l.target.id, (this.degree.get(l.target.id) || 0) + 1);
        this.neighbors.get(l.source.id).add(l.target.id);
        this.neighbors.get(l.target.id).add(l.source.id);
      }
      this.t = { x: 0, y: 0, k: 1 };
      this.userMoved = false;
      this.reheat(1);
    }

    radius(n) {
      const d = this.degree.get(n.id) || 0;
      return (n.id === this.current ? 6 : 3.5) + Math.min(6, Math.sqrt(d) * 1.1);
    }

    resize() {
      const rect = this.canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.w = rect.width;
      this.h = rect.height;
      this.canvas.width = Math.max(1, rect.width * dpr);
      this.canvas.height = Math.max(1, rect.height * dpr);
      this.canvas.style.width = rect.width + 'px';
      this.canvas.style.height = rect.height + 'px';
      this.dpr = dpr;
      this.draw();
    }

    reheat(a) {
      this.alpha = Math.max(this.alpha, a);
      if (!this.running) {
        this.running = true;
        requestAnimationFrame(() => this.loop());
      }
    }

    loop() {
      if (!this.canvas.isConnected) {
        this.running = false;
        this.ro.disconnect();
        return;
      }
      this.tick();
      if (!this.userMoved) this.fit();
      this.draw();
      this.alpha *= 0.985;
      if (this.alpha > 0.005 || this.drag) requestAnimationFrame(() => this.loop());
      else this.running = false;
    }

    tick() {
      const nodes = this.nodes;
      const a = this.alpha;
      // repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const p = nodes[i], q = nodes[j];
          let dx = q.x - p.x, dy = q.y - p.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
          if (d2 > 160000) continue;
          const f = (-1500 * a) / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          p.vx += fx; p.vy += fy; q.vx -= fx; q.vy -= fy;
        }
      }
      // springs
      for (const l of this.links) {
        const p = l.source, q = l.target;
        const dx = q.x - p.x, dy = q.y - p.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - 90) / d) * 0.06 * a;
        p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f;
      }
      // gravity + integrate
      for (const n of nodes) {
        n.vx -= n.x * 0.012 * a;
        n.vy -= n.y * 0.012 * a;
        if (n === this.drag) { n.vx = n.vy = 0; continue; }
        n.vx *= 0.6; n.vy *= 0.6;
        n.x += n.vx; n.y += n.vy;
      }
    }

    fit() {
      if (!this.nodes.length || !this.w) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of this.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
      const pad = 60;
      const k = Math.min(1.3, Math.max(0.25, Math.min((this.w - pad * 2) / Math.max(1, x1 - x0), (this.h - pad * 2) / Math.max(1, y1 - y0))));
      this.t = { x: -(x0 + x1) / 2, y: -(y0 + y1) / 2, k };
    }

    toScreen(n) {
      return { x: this.w / 2 + (n.x + this.t.x) * this.t.k, y: this.h / 2 + (n.y + this.t.y) * this.t.k };
    }
    toWorld(px, py) {
      return { x: (px - this.w / 2) / this.t.k - this.t.x, y: (py - this.h / 2) / this.t.k - this.t.y };
    }

    draw() {
      const ctx = this.ctx;
      if (!ctx || !this.nodes) return;
      const colNode = css('--graph-node') || '#3f9e6a';
      const colCurrent = css('--graph-current') || '#1d6b42';
      const colGhost = css('--graph-ghost') || '#b7d6c3';
      const colLine = css('--graph-line') || 'rgba(47,138,87,.3)';
      const colLineHi = css('--graph-line-hi') || 'rgba(47,138,87,.8)';
      const colText = css('--text-muted') || '#555';
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      const focus = this.hover;
      const nb = focus ? this.neighbors.get(focus.id) : null;

      for (const l of this.links) {
        const a = this.toScreen(l.source), b = this.toScreen(l.target);
        const hi = focus && (l.source === focus || l.target === focus);
        ctx.strokeStyle = hi ? colLineHi : colLine;
        ctx.globalAlpha = focus && !hi ? 0.35 : 1;
        ctx.lineWidth = hi ? 1.4 : 1;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const fontPx = Math.max(9, Math.min(13, 10 * this.t.k));
      ctx.font = `${fontPx}px ${css('--font') || 'system-ui, sans-serif'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const n of this.nodes) {
        const p = this.toScreen(n);
        const r = this.radius(n) * Math.max(0.6, Math.min(1.6, this.t.k));
        const dim = focus && n !== focus && !nb.has(n.id);
        ctx.globalAlpha = dim ? 0.3 : 1;
        ctx.fillStyle = n.ghost ? colGhost : n.id === this.current || n === focus ? colCurrent : colNode;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        const showLabel = this.t.k >= this.labelZoom || n === focus || n.id === this.current;
        if (showLabel) {
          ctx.fillStyle = colText;
          ctx.globalAlpha = dim ? 0.25 : 1;
          wrapText(ctx, n.label, p.x, p.y + r + 3, 120, fontPx + 2);
        }
      }
      ctx.globalAlpha = 1;
    }

    hit(px, py) {
      for (let i = this.nodes.length - 1; i >= 0; i--) {
        const n = this.nodes[i];
        const p = this.toScreen(n);
        const r = this.radius(n) * Math.max(0.6, Math.min(1.6, this.t.k)) + 4;
        if ((p.x - px) ** 2 + (p.y - py) ** 2 <= r * r) return n;
      }
      return null;
    }

    bindEvents() {
      const c = this.canvas;
      let pan = null, moved = false, down = null;
      const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      c.addEventListener('pointerdown', (e) => {
        const p = pos(e);
        down = p; moved = false;
        const n = this.hit(p.x, p.y);
        c.setPointerCapture(e.pointerId);
        this.userMoved = true;
        if (n) { this.drag = n; this.reheat(0.3); }
        else pan = { x: p.x, y: p.y, tx: this.t.x, ty: this.t.y };
      });
      c.addEventListener('pointermove', (e) => {
        const p = pos(e);
        if (down && Math.hypot(p.x - down.x, p.y - down.y) > 3) moved = true;
        if (this.drag) {
          const w = this.toWorld(p.x, p.y);
          this.drag.x = w.x; this.drag.y = w.y;
          this.reheat(0.3);
        } else if (pan) {
          this.t.x = pan.tx + (p.x - pan.x) / this.t.k;
          this.t.y = pan.ty + (p.y - pan.y) / this.t.k;
          this.draw();
        } else {
          const h = this.hit(p.x, p.y);
          if (h !== this.hover) { this.hover = h; c.style.cursor = h && !h.ghost ? 'pointer' : 'grab'; this.draw(); }
        }
      });
      const up = (e) => {
        const p = pos(e);
        if (!moved) { const n = this.hit(p.x, p.y); if (n && !n.ghost) this.onClick(n); }
        this.drag = null; pan = null; down = null;
      };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', () => { this.drag = null; pan = null; down = null; });
      c.addEventListener('pointerleave', () => { if (!this.drag && !pan) { this.hover = null; this.draw(); } });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.userMoved = true;
        const p = pos(e);
        const before = this.toWorld(p.x, p.y);
        this.t.k = Math.min(4, Math.max(0.2, this.t.k * Math.exp(-e.deltaY * 0.0015)));
        const after = this.toWorld(p.x, p.y);
        this.t.x += after.x - before.x;
        this.t.y += after.y - before.y;
        this.draw();
      }, { passive: false });
    }
  }

  function wrapText(ctx, text, x, y, maxW, lh) {
    const words = String(text).split(' ');
    let line = '';
    let lines = 0;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, y + lines * lh);
        line = w; lines++;
        if (lines >= 2) { ctx.fillText(line + '…', x, y + lines * lh); return; }
      } else line = test;
    }
    ctx.fillText(line, x, y + lines * lh);
  }

  window.PGSGraph = Graph;
})();
