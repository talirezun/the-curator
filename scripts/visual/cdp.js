/**
 * Minimal Chrome DevTools Protocol client — ZERO dependencies.
 *
 * WHY THIS EXISTS RATHER THAN PLAYWRIGHT/PUPPETEER
 * ------------------------------------------------
 * This repo has already REFUSED to commit Playwright as a devDependency, and
 * the reason is structural rather than aesthetic: the auto-updater runs
 * `npm install` on every end-user machine, so a browser-driver dependency
 * would download a ~150MB browser onto the machine of every person who has
 * ever installed The Curator, to support a test they will never run.
 *
 * Node 22 ships a WHATWG `WebSocket` on globalThis, and CDP is a plain
 * JSON-RPC-over-WebSocket protocol. Chrome (or Chromium, or Edge) is already
 * on the machine of anyone doing frontend work. So the whole driver is this
 * file plus a launcher: no package.json change, nothing shipped to users.
 *
 * SCOPE: this speaks exactly the slice of CDP the harness needs. It is not a
 * general automation library and should not grow into one.
 */

import { setTimeout as delay } from 'timers/promises';

const CONNECT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;

/** Open a WebSocket and resolve once it is OPEN (or reject on timeout/error). */
function openSocket(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* already gone */ }
      reject(new Error(`CDP connect timed out after ${CONNECT_TIMEOUT_MS}ms: ${url}`));
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`CDP socket error: ${url}`));
    });
  });
}

/**
 * A CDP connection. One socket to the BROWSER endpoint; page targets are
 * addressed through flattened sessions (Target.attachToTarget flatten:true)
 * rather than a second socket, so there is one message pump and one place
 * where a dropped connection surfaces.
 */
export class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this._nextId = 1;
    this._pending = new Map();          // id -> {resolve, reject, timer}
    this._listeners = new Map();        // "sessionId\0method" -> Set<fn>
    this._closed = false;

    ws.addEventListener('message', (ev) => this._onMessage(ev));
    ws.addEventListener('close', () => {
      this._closed = true;
      for (const [, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP connection closed with a command in flight'));
      }
      this._pending.clear();
    });
  }

  static async connect(browserWsUrl) {
    return new CdpConnection(await openSocket(browserWsUrl));
  }

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.id !== undefined) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`CDP ${p.method} failed: ${msg.error.message || JSON.stringify(msg.error)}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Event. Fan out to listeners registered for (sessionId, method) and for
    // (any-session, method).
    const keys = [
      `${msg.sessionId || ''}\0${msg.method}`,
      `*\0${msg.method}`,
    ];
    for (const k of keys) {
      const set = this._listeners.get(k);
      if (!set) continue;
      for (const fn of [...set]) {
        try { fn(msg.params || {}, msg.sessionId); } catch { /* a listener must never break the pump */ }
      }
    }
  }

  /** Subscribe to a CDP event. sessionId '*' means "from any session". */
  on(sessionId, method, fn) {
    const key = `${sessionId}\0${method}`;
    if (!this._listeners.has(key)) this._listeners.set(key, new Set());
    this._listeners.get(key).add(fn);
    return () => this._listeners.get(key)?.delete(fn);
  }

  /** Send a CDP command. `sessionId` null addresses the browser itself. */
  send(method, params = {}, sessionId = null) {
    if (this._closed) return Promise.reject(new Error(`CDP connection closed; cannot send ${method}`));
    const id = this._nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async close() {
    this._closed = true;
    try { this.ws.close(); } catch { /* already gone */ }
    // Give the socket a tick to unwind so Node does not hold the event loop.
    await delay(20);
  }
}

/**
 * A page target. Wraps the session id and the domains the harness enables,
 * and records every network response + console error for the caller.
 */
export class CdpPage {
  constructor(conn, sessionId, targetId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    /** Every network response this page received: {url, status, mimeType, type}. */
    this.responses = [];
    /** Console errors + uncaught exceptions, as strings. */
    this.consoleErrors = [];
    this._loadWaiters = new Set();
  }

  static async create(conn, url = 'about:blank') {
    const { targetId } = await conn.send('Target.createTarget', { url });
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new CdpPage(conn, sessionId, targetId);

    conn.on(sessionId, 'Network.responseReceived', (p) => {
      page.responses.push({
        url: p.response?.url || '',
        status: p.response?.status ?? 0,
        mimeType: p.response?.mimeType || '',
        type: p.type || '',
      });
    });
    // A request that never got a response at all (DNS/refused/blocked) is a
    // reachability failure too, and it produces NO responseReceived event.
    conn.on(sessionId, 'Network.loadingFailed', (p) => {
      page.responses.push({
        url: page._reqUrl.get(p.requestId) || '(unknown url)',
        status: 0,
        mimeType: '',
        type: p.type || '',
        failed: p.errorText || 'loading failed',
      });
    });
    page._reqUrl = new Map();
    conn.on(sessionId, 'Network.requestWillBeSent', (p) => {
      page._reqUrl.set(p.requestId, p.request?.url || '');
    });

    conn.on(sessionId, 'Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      page.consoleErrors.push((p.args || []).map(a => a.value ?? a.description ?? a.type).join(' '));
    });
    conn.on(sessionId, 'Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      page.consoleErrors.push(d.exception?.description || d.text || 'uncaught exception');
    });
    conn.on(sessionId, 'Page.loadEventFired', () => {
      for (const fn of [...page._loadWaiters]) fn();
    });

    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    return page;
  }

  send(method, params = {}) {
    return this.conn.send(method, params, this.sessionId);
  }

  /** Pin a deterministic viewport so geometry is reproducible across machines. */
  async setViewport(width, height, deviceScaleFactor = 1) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor, mobile: false,
    });
  }

  async navigate(url, { waitLoadMs = 20_000 } = {}) {
    this.responses = [];
    this.consoleErrors = [];
    const loaded = new Promise((resolve) => {
      const fn = () => { this._loadWaiters.delete(fn); resolve(); };
      this._loadWaiters.add(fn);
      setTimeout(() => { this._loadWaiters.delete(fn); resolve(); }, waitLoadMs);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /**
   * Evaluate an expression in the page and return its value.
   * `fn` is a function serialized to source, called with `args` (JSON-safe).
   */
  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`;
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`page evaluate threw: ${d.exception?.description || d.text}`);
    }
    return res.result?.value;
  }

  async close() {
    try { await this.conn.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* browser may be gone */ }
  }
}
