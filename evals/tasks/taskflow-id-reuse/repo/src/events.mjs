export function createEmitter() {
  const listeners = new Map();
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    emit(name, payload) {
      for (const fn of listeners.get(name) || []) fn(payload);
    },
    count(name) {
      return (listeners.get(name) || []).length;
    }
  };
}
