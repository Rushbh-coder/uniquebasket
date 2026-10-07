'use strict';
/** Promise-based mutex. One server process owns the database, so serialising critical writes here
 *  guarantees no two counters can interleave a stock / sequence / ledger update. */
class Mutex {
  constructor() { this.q = Promise.resolve(); this.waiting = 0; }
  run(fn) {
    this.waiting++;
    const p = this.q.then(() => fn()).finally(() => { this.waiting--; });
    this.q = p.catch(() => {});
    return p;
  }
}
module.exports = { Mutex };
