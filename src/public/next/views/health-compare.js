/**
 * views/health-compare.js — "Compare all remaining" on the Compare row of Wiki health.
 *
 * THE SERVER RUNS IT (src/brain/duplicate-job.js). This file only asks what it is doing and
 * says so. Nothing here starts spend except the one press on a confirm that showed the
 * total, and nothing here resumes by itself: a paused job stays paused until Resume.
 *
 * WHAT MUST NOT HAPPEN ON A LARGE DOMAIN. A poll tick that repaints the section: the job
 * runs for an hour or more, so a tick writes its figures straight into the row's own text
 * nodes (`patch`). A whole paint happens only when the job changes state or pairs arrive.
 * The next poll is scheduled after the last one answered, so a slow server can never have
 * two outstanding, and it stops when the domain leaves the screen; the job does not.
 *
 * WHAT IT WILL NOT SAY. A time it does not know: `timeBasis: 'assumed'` is another model's
 * speed, so the confirm says the time is not known. `secondsLeft` is this run's own measure
 * and is shown. And it never reads a price for an unpriced model: that is the server's
 * `costNote`, in tokens.
 *
 * Factory rather than module state so a suite can drive it with no browser. What it needs
 * from domains.js is in `deps`; the wiring is one block there.
 */
const POLL_MS = 2000;
const ACTIVE = new Set(['running', 'pausing']);

const n0 = (v) => (Number(v) || 0).toLocaleString('en-US');
const plural = (n, one, many) => (Number(n) === 1 ? one : many);

/** "about 12 minutes". Never a false precision: an estimate of this kind is good to a tenth. */
export function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return null;
  if (s < 60) return 'under a minute';
  const minutes = Math.round(s / 60);
  if (minutes < 60) return minutes + plural(minutes, ' minute', ' minutes');
  const h = Math.floor(minutes / 60);
  const m = Math.round((minutes - h * 60) / 5) * 5;
  const hours = h + plural(h, ' hour', ' hours');
  return m > 0 && m < 60 ? hours + ' ' + m + ' minutes' : hours;
}

/** "about 12 minutes", but never "about under a minute". */
function aboutTime(seconds) {
  const t = formatDuration(seconds);
  return !t ? null : t === 'under a minute' ? t : 'about ' + t;
}

/** What the confirm says, from the estimate the server just returned. Pure. */
export function compareAllConfirmCopy(est, { modelName, cost, usd }) {
  const pairs = est.pairs;
  const priced = typeof est.estimatedUsd === 'number';
  const stop = priced ? usd(est.estimatedUsd * est.stopMargin) : n0(Math.ceil(est.estimatedTokens * est.stopMargin)) + ' tokens';
  const time = est.timeBasis === 'measured' ? aboutTime(est.estimatedSeconds) : null;
  const figures = priced
    ? 'About ' + n0(est.estimatedTokens) + ' tokens and ' + cost(est) + (time ? ', ' + time + '.' : '.')
    : 'About ' + n0(est.estimatedTokens) + ' tokens' + (time ? ', ' + time : '') + '. ' + (est.costNote || 'Cost unknown.');
  const warn = [];
  if (est.overCeiling) {
    warn.push('This is above your limit of ' + n0(est.costCeilingTokens) + ' tokens for one run. This one confirm may go over it, because it shows the whole total, and it stops by itself at ' + stop + '.');
  }
  if (!time) warn.push('How long this takes is not known on ' + modelName + '.');
  if (est.rateBasis === 'assumed') warn.push('The tokens per pair have not been measured on ' + modelName + ', so these figures are an assumption.');
  if (est.rateBasis === 'measured-tokens') warn.push('The tokens per pair were measured on ' + modelName + '; how they split between input and output is an assumption.');
  if (est.fallbackNote) warn.push(est.fallbackNote);
  return {
    title: 'Compare all ' + n0(pairs) + plural(pairs, ' remaining pair?', ' remaining pairs?'),
    body: 'Sends the opening of each page to ' + modelName + '. ' + figures + ' You can pause and carry on later. It stops if it reaches ' + stop + '. Nothing is merged.',
    warn: warn.join(' '),
  };
}

/** The row's reading for a job, or null when the row should read as usual. Pure. */
export function compareJobReading(job, { usd }) {
  if (!job) return null;
  const p = job.progress || {};
  const at = p.totalPairs > 0 ? n0(p.checkedPairs) + ' of ' + n0(p.totalPairs) : null;
  if (ACTIVE.has(job.state)) return at ? 'Comparing ' + at + '…' : 'Comparing…';
  if (job.state !== 'paused') return null;
  if (job.pauseReason === 'restart') return at ? 'Paused when The Curator closed, at ' + at + '.' : 'Paused when The Curator closed.';
  return 'Paused' + (at ? ' at ' + at : '') + '. ' + spentWords(job, usd) + ' spent.';
}

function spentWords(job, usd) {
  const s = job.spent || {};
  if (job.limit && job.limit.kind === 'tokens') {
    return n0((s.inputTokens || 0) + (s.outputTokens || 0) + (s.cachedReadTokens || 0) + (s.cacheWriteTokens || 0)) + ' tokens';
  }
  return usd(s.usd || 0);
}

/** The line under the row: found so far, spend, time left. Pure. */
export function compareJobDetail(job, { usd }) {
  if (!job) return '';
  const p = job.progress || {};
  const parts = [];
  if (ACTIVE.has(job.state)) parts.push(spentWords(job, usd) + ' spent');
  if (job.state === 'paused' && job.pauseReason === 'restart') {
    parts.push(spentWords(job, usd) + ' spent' + (job.recovered ? ', perhaps one call more' : ''));
  }
  if ((ACTIVE.has(job.state) || job.state === 'paused') && p.found > 0) parts.push(n0(p.found) + plural(p.found, ' new pair found so far', ' new pairs found so far'));
  if (ACTIVE.has(job.state) && Number.isFinite(job.secondsLeft) && job.secondsLeft > 0) parts.push(aboutTime(job.secondsLeft) + ' left');
  return parts.join(' · ');
}

/** What stays under the row after the job has said something. Pure. Null: nothing to say. */
export function compareJobNote(job, { usd }) {
  if (!job) return null;
  if (job.state === 'paused') {
    if (job.pauseReason === 'restart') return { tone: 'quiet', text: 'Nothing runs until you press Resume.' };
    if (job.pauseReason === 'provider-errors') return { tone: 'error', text: job.reason || 'The AI calls failed, so the comparison paused.' };
    return null;
  }
  if (job.state === 'stopped') {
    if (job.stopReason === 'user') return null;
    const carry = ' To carry on, compare again: it asks you to confirm a new amount.';
    const spent = job.stopReason === 'spend-limit' ? '' : ' ' + spentWords(job, usd) + ' spent.';
    return { tone: 'error', text: (job.reason || 'The comparison stopped.') + spent + (job.stopReason === 'domain-missing' ? '' : carry) };
  }
  if (job.state === 'failed') return { tone: 'error', text: (job.reason || 'The comparison stopped.') + ' ' + spentWords(job, usd) + ' spent.' };
  if (job.state === 'done' && job.progress && job.progress.failedPairs > 0) {
    const n = job.progress.failedPairs;
    return { tone: 'quiet', text: n0(n) + plural(n, ' pair', ' pairs') + ' could not be compared because the AI call failed. They will be tried again next time.' };
  }
  return null;
}

export function createCompareAll(deps) {
  const jobs = new Map();    // slug → the last job read
  const quotes = new Map();  // slug → { est, failed? }: what the chip wears
  const acked = new Map();   // slug → the finishedAt of a job whose note has been superseded
  const quoting = new Set();
  let pollTimer = null;
  let pollSlug = null;
  let pressing = null;       // 'pause' | 'resume' | 'stop' while its request is out
  let pulling = false;
  let foundSeen = new Map(); // slug → progress.found when pairs were last read

  const api = (slug, tail) => '/api/health/' + encodeURIComponent(slug) + '/semantic-dupes/compare-all/' + tail;
  const copy = { usd: deps.usd };

  function shownJob(slug) {
    if (!deps.offered(slug)) return null;
    const job = jobs.get(slug);
    if (!job || job.state === 'none') return null;
    return job;
  }

  function running(slug) {
    const job = shownJob(slug);
    return !!job && ACTIVE.has(job.state);
  }

  function schedule(slug) {
    clearTimeout(pollTimer);
    pollSlug = slug;
    pollTimer = setTimeout(() => { tick(slug); }, deps.pollMs || POLL_MS);
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
    pollSlug = null;
  }

  /** Into the row's own text nodes: no paint, no layout but the words. */
  function patch(slug) {
    if (typeof document === 'undefined') return;
    const job = shownJob(slug);
    const section = document.querySelector('.dm-health');
    if (!section || !job) return;
    const reading = section.querySelector('[data-compare-reading]');
    const words = compareJobReading(job, copy);
    if (reading && words && reading.textContent !== words) reading.textContent = words;
    const detail = section.querySelector('[data-compare-detail]');
    const text = compareJobDetail(job, copy);
    if (detail && detail.textContent !== text) detail.textContent = text;
  }

  function pullPairs(slug, job) {
    const found = job && job.progress ? job.progress.found : 0;
    if (pulling || found === (foundSeen.get(slug) || 0)) return;
    pulling = true;
    foundSeen.set(slug, found);
    Promise.resolve().then(() => deps.pullPairs(slug)).then(() => {
      if (slug === deps.slug() && deps.mounted()) deps.render();
    }).catch(() => { /* free and optional: the next tick asks again */ foundSeen.delete(slug); }).finally(() => { pulling = false; });
  }

  function announce(job) {
    const reading = compareJobReading(job, copy);
    const note = compareJobNote(job, copy);
    deps.live([reading, note && note.text].filter(Boolean).join(' '));
  }

  function take(slug, job) {
    const was = jobs.get(slug);
    jobs.set(slug, job);
    const moved = !was || was.state !== job.state;
    // Only a job this page is watching. An old record is older than the row's own count (a
    // merge, a short run), and it could land after that count had.
    if (job && job.progress && job.progress.totalPairs > 0 && (ACTIVE.has(job.state) || (was && ACTIVE.has(was.state)))) {
      deps.setCoverage(job.progress.totalPairs, job.progress.checkedPairs);
    }
    return { was, moved };
  }

  async function tick(slug) {
    pollTimer = null;
    if (slug !== deps.slug() || !deps.mounted()) { stopPolling(); return; }
    let job;
    try {
      const r = await deps.fetchJSON(api(slug, 'status'));
      job = r.job;
    } catch {
      // A server that restarts mid-poll: keep asking, and it will read paused.
      schedule(slug);
      return;
    }
    if (slug !== deps.slug() || !deps.mounted()) { stopPolling(); return; }
    const { was, moved } = take(slug, job);
    if (moved) {
      if (was && ACTIVE.has(was.state) && !ACTIVE.has(job.state)) {
        quotes.delete(slug);
        if (pressing === 'pause') pressing = null;
        announce(job);
        foundSeen.delete(slug);
        pullPairs(slug, job);
        deps.ended(slug);
      }
      deps.render();
    } else {
      patch(slug);
      pullPairs(slug, job);
    }
    if (ACTIVE.has(job.state)) schedule(slug); else stopPolling();
  }

  /** The panel opened or came back: what is the job doing? */
  async function sync(slug) {
    if (!deps.offered(slug)) return;
    try {
      const r = await deps.fetchJSON(api(slug, 'status'));
      if (slug !== deps.slug()) return;
      const { moved } = take(slug, r.job);
      if (moved) deps.render(); else patch(slug);
      // Pairs found while nobody was looking. Once per page, however often the panel is read.
      if (r.job && r.job.progress && r.job.progress.found > 0) pullPairs(slug, r.job);
      if (ACTIVE.has(r.job.state)) { if (pollSlug !== slug || !pollTimer) schedule(slug); }
    } catch { /* free and optional: the row reads as usual without it */ }
  }

  async function press(slug) {
    deps.setBusy(true);
    let est;
    try {
      est = await deps.fetchJSON(api(slug, 'estimate'));
    } catch (err) {
      deps.setBusy(false);
      deps.note(slug, 'Could not compare pages: ' + err.message, () => press(slug));
      return;
    }
    deps.setBusy(false);
    if (slug !== deps.slug() || !deps.mounted()) return;
    quotes.set(slug, { est });
    if (est.job) take(slug, est.job);
    if (est.job && est.job.runningElsewhere) {
      deps.note(slug, 'A comparison is already running in "' + est.job.runningElsewhere + '". It keeps going on its own; this one was not started.', () => press(slug));
      return;
    }
    if (!(est.pairs > 0)) { deps.render(); return; }
    const words = compareAllConfirmCopy(est, { modelName: deps.modelName(est), cost: deps.cost, usd: deps.usd });
    deps.ask({
      title: words.title, body: words.body, warn: words.warn, tier: 'ai',
      confirmLabel: 'Compare all for', costText: deps.cost(est, { compact: true }) || '', busyLabel: 'Comparing…',
      run: () => start(slug, est),
    });
  }

  async function start(slug, est) {
    const body = { confirmedModel: est.model };
    if (typeof est.estimatedUsd === 'number') body.confirmedUsd = est.estimatedUsd;
    else body.confirmedTokens = est.estimatedTokens;
    try {
      const r = await deps.fetchJSON(api(slug, 'start'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      acked.delete(slug);
      foundSeen.set(slug, 0);
      take(slug, r.job);
      deps.focusAfterStart();
      deps.live(compareJobReading(r.job, copy) || '');
      schedule(slug);
      deps.render();
    } catch (err) {
      deps.note(slug, err.message, () => press(slug));
    }
  }

  async function act(slug, what) {
    pressing = what;
    deps.render();
    try {
      const r = await deps.fetchJSON(api(slug, what), { method: 'POST' });
      if (what !== 'pause') pressing = null;
      take(slug, r.job);
      if (what === 'stop') {
        deps.live('Stopped.');
        deps.ended(slug);
        deps.render();
        deps.focusAfterStop();
        return;
      }
      if (what === 'resume') foundSeen.set(slug, r.job.progress ? r.job.progress.found : 0);
      if (ACTIVE.has(r.job.state)) schedule(slug);
      deps.render();
    } catch (err) {
      pressing = null;
      await sync(slug);
      deps.note(slug, err.message, () => act(slug, what));
    }
  }

  return {
    sync, press, running,

    reading: (slug) => compareJobReading(shownJob(slug), copy),

    /** The row's buttons. `nextChip` is what the row would show with no job. */
    actions(slug, nextChip, c, { noKeyAttrs = '', disabled = false } = {}) {
      const job = shownJob(slug);
      if (job && ACTIVE.has(job.state)) {
        const busy = job.state === 'pausing' || pressing === 'pause';
        return '<button class="btn btn-secondary dm-compare-job-btn" id="dm-compare-job-btn" data-compare-do="pause"' + (busy ? ' aria-busy="true" aria-disabled="true"' : '') + '>' +
          (busy ? deps.ring() + ' Pausing…' : 'Pause') + '</button>';
      }
      if (job && job.state === 'paused') {
        const r = pressing === 'resume';
        const s = pressing === 'stop';
        return '<button class="btn btn-ai dm-compare-job-btn" id="dm-compare-job-btn" data-compare-do="resume"' + (r || s ? ' aria-busy="true" aria-disabled="true"' : '') + '>' + (r ? deps.ring() + ' Resuming…' : 'Resume') + '</button>' +
          '<button class="btn btn-secondary dm-compare-job-stop" id="dm-compare-job-stop" data-compare-do="stop"' + (r || s ? ' aria-busy="true" aria-disabled="true"' : '') + '>' + (s ? deps.ring() + ' Stopping…' : 'Stop') + '</button>';
      }
      // "Compare the next N" already covers it when what is left fits in one run.
      const offered = c && c.checked > 0 && c.left > c.next && deps.offered(slug);
      // Before a first run the chip is not offered, and the run will bring it while its question
      // is still closing under this row. Where the row is too narrow for both chips it has a line
      // of its own (health-compare.css), kept from the start, so the question does not move.
      const line = (inner) => '<span class="dm-compare-all-line">' + inner + '</span>';
      if (!offered) return nextChip + (c && c.left > c.next && deps.offered(slug) ? line('') : '');
      const q = quotes.get(slug);
      const est = q && q.est;
      const scaled = est && est.pairs > 0 && typeof est.estimatedUsd === 'number' && est.pairs !== c.left
        ? Object.assign({}, est, { estimatedUsd: est.estimatedUsd * (c.left / est.pairs) }) : est;
      const cost = scaled ? (deps.cost(scaled, { compact: true }) || '') : '';
      const failed = !!(q && q.failed);
      const asking = deps.busy();
      return nextChip + line(deps.chip({
        attrs: asking ? ' aria-busy="true" aria-disabled="true"' : (noKeyAttrs || (disabled || (!cost && !failed) ? ' disabled' : '')),
        leadHtml: asking ? deps.ring() : deps.sparkles(),
        label: 'Compare all ' + n0(c.left), cost: asking ? '' : cost,
      }));
    },

    /** The line under the row, always the same node while there is anything to say. */
    line(slug, arrivals = 0) {
      const job = shownJob(slug);
      const detail = compareJobDetail(job, copy);
      const raw = compareJobNote(job, copy);
      const note = raw && job.finishedAt && acked.get(slug) === job.finishedAt ? null : raw;
      if (!detail && !note && !arrivals) return '';
      const review = arrivals > 0
        ? '<span class="dm-compare-arrivals">' + n0(arrivals) + plural(arrivals, ' pair to review', ' pairs to review') + '</span> ' +
          '<button class="btn btn-secondary btn-xs dm-review-btn dm-compare-review" data-review="1">Review</button>' : '';
      return '<div class="dm-compare-job" data-row-key="compare-job">' +
        ((detail || review) ? '<div class="dm-compare-job-line"><span data-compare-detail>' + deps.escape(detail) + '</span>' + review + '</div>' : '') +
        (note ? (note.tone === 'error'
          // The row's own failure look: it stays until you act on it (press rule 8).
          ? '<div class="dm-outcome dm-outcome-failed dm-compare-job-note" data-row-key="compare-job-note">' + deps.alert() + '<span class="dm-outcome-text">' + deps.escape(note.text) + '</span></div>'
          : '<div class="dm-compare-job-note" data-row-key="compare-job-note">' + deps.escape(note.text) + '</div>') : '') +
      '</div>';
    },

    onClick(btn) {
      const what = btn.dataset && btn.dataset.compareDo;
      if (!what) return false;
      const slug = deps.slug();
      if (pressing) return true;
      pressing = what; // here, not after the next tick: a double click is two presses in one tick
      Promise.resolve().then(() => act(slug, what)).catch(() => {});
      return true;
    },

    /** Read what the chip wears, once its row has settled. A slow read, so never during a count. */
    afterPaint(c) {
      const slug = deps.slug();
      if (!slug || !c || !deps.offered(slug) || running(slug) || deps.scanCounting() || deps.busy()) return;
      const job = shownJob(slug);
      if (job && job.state === 'paused') return;
      if (!(c.checked > 0 && c.left > c.next) || quotes.has(slug) || quoting.has(slug)) return;
      quoting.add(slug);
      deps.fetchJSON(api(slug, 'estimate')).then((est) => {
        quotes.set(slug, { est });
        if (est.job) take(slug, est.job);
      }).catch(() => { quotes.set(slug, { failed: true }); }).finally(() => {
        quoting.delete(slug);
        if (slug === deps.slug() && deps.mounted()) deps.render();
      });
    },

    noteQuote(slug, est) { if (!quotes.has(slug)) quotes.set(slug, { est }); },
    forgetQuote(slug) { quotes.delete(slug); },
    /** A later run has superseded what the last job had to say about itself. */
    acknowledge(slug) {
      const job = jobs.get(slug);
      if (job && job.finishedAt) acked.set(slug, job.finishedAt);
      quotes.delete(slug);
    },
    stopPolling,
  };
}
