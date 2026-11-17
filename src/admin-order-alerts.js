const pendingCursor = (latestPending) => {
  if (!latestPending?.id || !latestPending?.createdAt) return '';
  return `${latestPending.createdAt}\u0000${latestPending.id}`;
};

export const initialPendingOrderSnapshot = Object.freeze({
  initialized: false,
  count: 0,
  cursor: '',
});

export function nextPendingOrderSnapshot(previous, payload) {
  const current = previous || initialPendingOrderSnapshot;
  const count = Math.max(0, Number(payload?.counts?.pending || 0));
  const latestCursor = pendingCursor(payload?.latestPending);
  const shouldNotify = current.initialized && (
    count > current.count
    || (latestCursor && latestCursor > current.cursor)
  );

  return {
    shouldNotify: Boolean(shouldNotify),
    snapshot: {
      initialized: true,
      count,
      // Keep a high-water mark. When the newest order is confirmed, an older
      // pending row must not be mistaken for a newly arrived order.
      cursor: latestCursor > current.cursor ? latestCursor : current.cursor,
    },
  };
}

async function readyAudioContext(contextRef) {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    let context = contextRef.current;
    if (!context || context.state === 'closed') {
      context = new AudioContextClass();
      contextRef.current = context;
    }
    if (context.state === 'suspended') await context.resume();
    return context.state === 'running' ? context : null;
  } catch {
    return null;
  }
}

export async function unlockOrderAudio(contextRef) {
  return Boolean(await readyAudioContext(contextRef));
}

export async function playOrderChime(contextRef) {
  try {
    const context = await readyAudioContext(contextRef);
    if (!context) return false;

    const startedAt = context.currentTime;
    for (const [offset, frequency] of [[0, 659.25], [0.16, 880]]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, startedAt + offset);
      gain.gain.setValueAtTime(0.0001, startedAt + offset);
      gain.gain.exponentialRampToValueAtTime(0.16, startedAt + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + offset + 0.2);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(startedAt + offset);
      oscillator.stop(startedAt + offset + 0.21);
    }
    return true;
  } catch {
    return false;
  }
}
