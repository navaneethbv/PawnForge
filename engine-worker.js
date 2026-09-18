import { spawn } from 'node:child_process';

export class EngineWorker {
  constructor(binary, { timeoutMs = 15000, maxPending = 8 } = {}) {
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.pending = 0;
    this.queue = Promise.resolve();
    this.session = null;
  }

  start() {
    const proc = spawn(this.binary);
    const session = { proc, lines: [], buffer: '', waiters: new Set(), error: null, ready: false };
    this.session = session;
    const fail = (error) => {
      session.error = error;
      for (const wake of session.waiters) wake();
    };
    proc.on('error', fail);
    proc.on('exit', () => fail(new Error('Engine process exited')));
    proc.stdin.on('error', fail);
    proc.stderr.resume();
    proc.stdout.on('data', (data) => {
      session.buffer += data.toString();
      const lines = session.buffer.split(/\r?\n/);
      session.buffer = lines.pop();
      session.lines.push(...lines.map((line) => line.trim()).filter(Boolean));
      for (const wake of session.waiters) wake();
    });
    this.send('uci');
    this.send('isready');
    return session;
  }

  send(command) {
    const session = this.session;
    if (!session || session.error) throw session?.error || new Error('Engine stopped');
    session.proc.stdin.write(`${command}\n`);
  }

  async waitFor(predicate, timeoutMs = 4000) {
    const session = this.session;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (session.error) throw session.error;
      const index = session.lines.findIndex(predicate);
      if (index >= 0) return session.lines.splice(0, index + 1).at(-1);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Engine timeout');
      await new Promise((resolve, reject) => {
        const wake = () => { clearTimeout(timer); session.waiters.delete(wake); resolve(); };
        const timer = setTimeout(() => { session.waiters.delete(wake); reject(new Error('Engine timeout')); }, remaining);
        session.waiters.add(wake);
      });
    }
  }

  stop(error = new Error('Engine stopped')) {
    const session = this.session;
    if (!session) return;
    session.error = error;
    for (const wake of session.waiters) wake();
    session.proc.kill('SIGKILL');
    this.session = null;
  }

  run(task, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pending >= this.maxPending) return Promise.reject(Object.assign(new Error('Engine busy. Try again shortly.'), { statusCode: 429 }));
    this.pending += 1;
    const deadline = Date.now() + this.timeoutMs;
    const job = this.queue.then(async () => {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw Object.assign(new Error('Engine queue timeout'), { statusCode: 503 });
      let timer;
      const abort = () => this.stop(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (!this.session || this.session.error) { this.stop(); this.start(); }
        timer = setTimeout(() => this.stop(new Error('Engine job deadline exceeded')), deadline - Date.now());
        if (!this.session.ready) {
          await this.waitFor((line) => line === 'uciok');
          await this.waitFor((line) => line === 'readyok');
          this.session.ready = true;
        }
        return await task(this);
      } catch (error) {
        this.stop(error);
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    }).finally(() => { this.pending -= 1; });
    this.queue = job.catch(() => {});
    return job;
  }
}
