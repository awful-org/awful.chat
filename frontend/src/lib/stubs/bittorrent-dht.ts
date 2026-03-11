// src/lib/stubs/bittorrent-dht.ts
import { EventEmitter } from "events";

export class Client extends EventEmitter {
  listen(_port?: number, cb?: () => void) {
    if (cb) cb();
  }
  announce() {}
  lookup() {}
  destroy(cb?: () => void) {
    if (cb) cb();
  }
}

export default { Client };
