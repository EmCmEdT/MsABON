function ts() {
  return new Date().toISOString();
}

function info(...args) {
  console.log(`[INFO] ${ts()} -`, ...args);
}

function warn(...args) {
  console.warn(`[WARN] ${ts()} -`, ...args);
}

function error(...args) {
  console.error(`[ERROR] ${ts()} -`, ...args);
}

function verbose(...args) {
  console.log(`[VERBOSE] ${ts()} -`, ...args);
}

module.exports = { info, warn, error, verbose };
