/**
 * Collects draw items into one run per draw date.
 *
 * One embed is one item, but one draw is one post set, so detections have to be
 * grouped before anything fires. The first item opens a run and starts a quiet
 * timer; each further item for the same draw date joins the run and restarts
 * that timer. The run fires once nothing new has arrived for QUIET_PERIOD, or
 * when CEILING has elapsed since the first item, whichever comes first.
 *
 * The ceiling exists so a slow trickle cannot hold a run open indefinitely.
 */
export class Batcher {
  constructor({
    quietMs = 300_000,
    ceilingMs = 1_200_000,
    lateWindowMs = 21_600_000, // 6h: how long after firing a repost is still recognised
    onFire,
    onLate,
    clock = Date.now,
  } = {}) {
    this.quietMs = quietMs;
    this.ceilingMs = ceilingMs;
    this.lateWindowMs = lateWindowMs;
    this.onFire = onFire;
    this.onLate = onLate;
    this.clock = clock;
    this.runs = new Map();   // drawDate -> { items: Map<pid,item>, firstSeen, quietTimer, ceilingTimer }
    this.fired = new Map();  // drawDate -> { firedAt, pids: Set }
  }

  add(item) {
    const key = item.drawDate;
    this.#prune();

    // A draw date that has already fired must never silently open a second run.
    // A repost of an item that run already held is noise and is dropped. A
    // genuinely new item is late, which is the amend case: the image and the
    // scheduled posts are now wrong and a human has to be told.
    const done = this.fired.get(key);
    if (done) {
      if (done.pids.has(item.pid)) return { joined: false, repeatAfterFire: true, size: done.pids.size };
      done.pids.add(item.pid);
      this.onLate?.({ drawDate: key, item });
      return { joined: false, late: true, size: done.pids.size };
    }

    let run = this.runs.get(key);

    if (!run) {
      run = { drawDate: key, items: new Map(), firstSeen: this.clock(), quietTimer: null, ceilingTimer: null };
      this.runs.set(key, run);
      run.ceilingTimer = setTimeout(() => this.#fire(key, 'ceiling'), this.ceilingMs);
      run.ceilingTimer.unref?.();
    }

    const known = run.items.get(item.pid);
    run.items.set(item.pid, item);

    // A repeat of an item we already hold is the monitor reposting or the bot
    // restarting. It joins the run but must not extend the quiet period,
    // otherwise a chatty monitor could defer the run past its own draw.
    if (!known) this.#resetQuiet(key);
    return { joined: !known, size: run.items.size };
  }

  #resetQuiet(key) {
    const run = this.runs.get(key);
    if (!run) return;
    if (run.quietTimer) clearTimeout(run.quietTimer);
    run.quietTimer = setTimeout(() => this.#fire(key, 'quiet'), this.quietMs);
    run.quietTimer.unref?.();
  }

  #fire(key, reason) {
    const run = this.runs.get(key);
    if (!run) return;
    this.runs.delete(key);
    if (run.quietTimer) clearTimeout(run.quietTimer);
    if (run.ceilingTimer) clearTimeout(run.ceilingTimer);
    const items = [...run.items.values()];
    this.fired.set(key, { firedAt: this.clock(), pids: new Set(items.map((i) => i.pid)) });
    this.onFire?.({ drawDate: run.drawDate, items, reason, firstSeen: run.firstSeen });
  }

  #prune() {
    const cutoff = this.clock() - this.lateWindowMs;
    for (const [key, rec] of this.fired) if (rec.firedAt < cutoff) this.fired.delete(key);
  }

  /** Fire everything now. Used on shutdown so nothing in flight is lost. */
  flush() {
    for (const key of [...this.runs.keys()]) this.#fire(key, 'flush');
  }

  pending() {
    return [...this.runs.values()].map((r) => ({ drawDate: r.drawDate, size: r.items.size }));
  }
}
