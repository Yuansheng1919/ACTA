export class Fault extends Error {
  constructor(status, code, metrics = {}) {
    super(code);
    Object.assign(this, { status, code, metrics });
  }
}

export function reject(status, code, metrics) {
  throw new Fault(status, code, metrics);
}
