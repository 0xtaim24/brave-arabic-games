// One resident local recognizer; requests are serialized so PCM frames never interleave.
const { spawn, execFile } = require('child_process');

class SttWorker {
  constructor(command, env) {
    this.child = spawn(command.cmd, [...command.args, '--stt-json'], { cwd: command.cwd, env, windowsHide: true });
    this.buffer = ''; this.stderr = ''; this.waiters = []; this.lines = []; this.dead = false;
    this.tail = Promise.resolve(); this.started = Date.now(); this.first = true;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1);
        const next = this.waiters.shift(); if (next) next.resolve(line); else this.lines.push(line);
      }
    });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2500); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error(this.stderr.trim().split('\n').pop() || 'توقف محرك التعرّف')));
    this.ready = this.line().then(line => {
      if (line !== 'READY') throw new Error(line);
      this.loadSeconds = (Date.now() - this.started) / 1000;
    });
    this.ready.catch(() => {});
  }
  fail(error) {
    this.dead = true; this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  line() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.dead) return Promise.reject(this.error || new Error('توقف محرك التعرّف'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  transcribe(pcm, profile) {
    const task = this.tail.then(async () => {
      const timer = setTimeout(() => this.close(new Error('التعرّف استغرق وقتًا طويلًا. جرّب إعدادًا أخف.')), 120000);
      try {
        await this.ready;
        this.child.stdin.write(JSON.stringify({ n: pcm.length / 4, lang: 'ar', profile }) + '\n');
        this.child.stdin.write(pcm);
        const line = await this.line();
        if (!line.startsWith('OK ')) throw new Error(line);
        const result = JSON.parse(line.slice(3));
        result.load_s = this.first ? Math.round(this.loadSeconds * 10) / 10 : 0;
        this.first = false;
        return { ok: true, ...result };
      } finally { clearTimeout(timer); }
    });
    this.tail = task.catch(() => {});
    return task;
  }
  close(error = new Error('أُغلق محرك التعرّف')) {
    this.fail(error);
    // Windows launchers and frozen helpers may own a child process that holds the GPU.
    if (process.platform === 'win32' && this.child.pid) {
      return new Promise(resolve => execFile('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }, resolve));
    } else { this.child.kill(); return Promise.resolve(); }
  }
}

module.exports = { SttWorker };
