// Ambient particle field behind the workspace: slow green motes that drift
// upward and quicken a little while the agent works. Built to cost almost
// nothing: one canvas, at most ~70 particles, capped at 30 frames a second,
// paused when the tab is hidden, and never started with reduced motion,
// on low-power devices or when turned off in Settings.

export function particleCount(width, height) {
  return Math.max(18, Math.min(70, Math.round((width * height) / 26000)));
}

export function ambientField(canvas, { win = globalThis, busy = () => false, accent = () => '#9BFF55' } = {}) {
  const ctx = canvas.getContext && canvas.getContext('2d');
  let running = false;
  let frame = 0;
  let last = 0;
  let particles = [];
  let width = 0;
  let height = 0;
  let ratio = 1;
  let color = accent();
  let energy = 0;

  function seed() {
    ratio = Math.min(2, win.devicePixelRatio || 1);
    width = canvas.clientWidth || win.innerWidth;
    height = canvas.clientHeight || win.innerHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const count = particleCount(width, height);
    particles = Array.from({ length: count }, () => spawn(true));
  }
  function spawn(anywhere) {
    return {
      x: Math.random() * width,
      y: anywhere ? Math.random() * height : height + 10,
      r: 0.6 + Math.random() * 1.6,
      vy: 0.08 + Math.random() * 0.22,
      phase: Math.random() * Math.PI * 2,
      drift: 0.15 + Math.random() * 0.35,
      alpha: 0.12 + Math.random() * 0.38
    };
  }
  function draw(time) {
    if (!running) return;
    frame = win.requestAnimationFrame(draw);
    if (time - last < 33) return;
    const dt = Math.min(3, (time - last) / 16.7 || 1);
    last = time;
    energy += ((busy() ? 1 : 0) - energy) * 0.04;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    for (const p of particles) {
      p.phase += 0.012 * dt;
      p.y -= p.vy * dt * (1 + energy * 2.2);
      // A slow sway plus a tiny jitter keeps the motes alive, not mechanical.
      p.x += Math.sin(p.phase) * p.drift * 0.3 * dt + (Math.random() - 0.5) * 0.08 * (1 + energy);
      if (p.y < -10 || p.x < -10 || p.x > width + 10) Object.assign(p, spawn(false));
      const twinkle = 0.65 + Math.sin(p.phase * 2.3) * 0.35;
      ctx.globalAlpha = p.alpha * twinkle * (0.7 + energy * 0.5);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function onVisibility() {
    if (win.document && win.document.hidden) { win.cancelAnimationFrame(frame); }
    else if (running) { last = 0; frame = win.requestAnimationFrame(draw); }
  }
  let resizeTimer = 0;
  function onResize() { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (running) seed(); }, 150); }
  return {
    start() {
      if (running || !ctx) return false;
      running = true;
      color = accent();
      seed();
      canvas.hidden = false;
      win.addEventListener('resize', onResize);
      win.document && win.document.addEventListener('visibilitychange', onVisibility);
      frame = win.requestAnimationFrame(draw);
      return true;
    },
    stop() {
      running = false;
      win.cancelAnimationFrame(frame);
      win.removeEventListener('resize', onResize);
      win.document && win.document.removeEventListener('visibilitychange', onVisibility);
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.hidden = true;
    },
    recolor() { color = accent(); },
    get running() { return running; }
  };
}
