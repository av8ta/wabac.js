"use strict";

import { openDB } from 'idb/with-async-ittr.js';
import { tsToDate, isNullBodyStatus, makeHeaders } from './utils';
import { fuzzyMatcher, fuzzyCompareUrls } from './fuzzymatcher';
import { STATUS_CODES } from 'http';


// ===========================================================================
class ArchiveDB {
  constructor(name, opts = {}) {
    this.name = name;
    this.db = null;

    const { minDedupSize } = opts;
    this.minDedupSize = Number.isInteger(minDedupSize) ? minDedupSize : 1024;

    this.initing = this.init();
    this.version = 1;

    this.allowRepeats = true;
    this.repeatTracker = this.allowRepeats ? new RepeatTracker() : null;
    this.fuzzyPrefixSearch = true;
  }

  async init() {
    this.db = await openDB(this.name, this.version, {
      upgrade: (db, oldV, newV, tx) => this._initDB(db, oldV, newV, tx),
      blocking: (e) => { if (e.newVersion === null) { this.close(); }}
    });
  }

  _initDB(db, oldV, newV, tx) {
    const pageStore = db.createObjectStore("pages", { keyPath: "id" });
    pageStore.createIndex("url", "url");
    pageStore.createIndex("date", "date");

    const urlStore = db.createObjectStore("resources", { keyPath: ["url", "ts"] });
    urlStore.createIndex("pageId", "pageId");
    //urlStore.createIndex("ts", "ts");
    urlStore.createIndex("pageMime", ["page", "mime"]);

    const payload = db.createObjectStore("payload", { keyPath: "digest", unique: true});
    const digestRef = db.createObjectStore("digestRef", { keyPath: "digest", unique: true});

    const fuzzyStore = db.createObjectStore("fuzzy", { keyPath: "key" });
  }

  async clearAll() {
    const stores = ["pages", "resources", "payload", "digestRef", "fuzzy"];
    const tx = this.db.transaction(stores, "readwrite");

    for (const store of stores) {
      this.db.clear(store);
    }

    await tx.done;
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }

  async addPage(data) {
    if (!data.id) {
      data.id = this.newPageId();
    }
    return await this.db.put("pages", data);
  }

  //from http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
  newPageId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }

  async getAllPages() {
    return await this.db.getAllFromIndex("pages", "date");
  }

  async getDigest(payload, type = "sha-256") {
    const hashBuffer = await crypto.subtle.digest(type, payload);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return type + ":" + hashHex;
  }

  async dedupResource(data) {
    const payload = data.payload;
    if (!payload || payload.length < this.minDedupSize) {
      return {tx: this.db.transaction("resources", "readwrite"), added: false};
    }

    const digest = await this.getDigest(payload);
    const tx = this.db.transaction(["payload", "digestRef", "resources"], "readwrite");

    const digestRefStore = tx.objectStore("digestRef");
    const ref = await digestRefStore.get(digest);
    let added = true;

    if (ref) {
      //console.log("Digest Dupe: " + digest + " for " + data.url);
      ++ref.count;
      digestRefStore.put(ref);
      added = false;
    } else {
      try {
        tx.objectStore("payload").add({digest, payload});
        const size = data.payload.length;
        const count = 1;
        digestRefStore.put({digest, count, size});
      } catch (e) {
        console.log(e);
      }
    }

    delete data.payload;
    data.digest = digest;

    return {tx, added};
  }

  async addResource(data, addFuzzy = true) {
    let result = null;

    let { tx, added } = await this.dedupResource(data);

    try {
      tx.objectStore("resources").put(data);
      await tx.done;

    } catch (e) {
      console.warn(`Resource Add Error: ${data.url}`);
      console.warn(e);
      added = false;
    }

    if (addFuzzy && data.status >= 200 && data.status < 300 && data.status != 204) {
      for await (const fuzzyUrl of fuzzyMatcher.fuzzyUrls(data.url)) {
        if (fuzzyUrl === data.url) {
          continue;
        }

        try {
          await this.db.add("fuzzy", {
            key: fuzzyUrl,
            ts: data.ts,
            original: data.url,
            pageId: data.pageId
          });
        } catch (e) {
          //console.warn(`Fuzzy Add Error: ${fuzzyUrl}`);
          //console.warn(e);
        }
      }
    }

    return added;
  }

  async getResource(request, rwPrefix, event) {
    const datetime = tsToDate(request.timestamp).getTime();
    let url = request.url;

    let result = null;

    const skip = this.repeatTracker ? this.repeatTracker.getSkipCount(event, url, request.method) : 0;

    if (url.startsWith("//")) {
      result = await this.lookupUrl("https:" + url, datetime, skip);
      if (!result) {
        result = await this.lookupUrl("http:" + url, datetime, skip);
        url = "http:" + url;
      } else {
        url = "https:" + url;
      }
    } else {
      result = await this.lookupUrl(url, datetime, skip);
    }

    if (!result) {
      for await (const fuzzyUrl of fuzzyMatcher.fuzzyUrls(url)) {
        let origUrl = null;
        result = await this.lookupFuzzyUrl(fuzzyUrl);
        if (result) {
          origUrl = result.original;
          result = await this.lookupUrl(origUrl, datetime, skip);
        }
        if (result) {
          url = origUrl;
          break;
        }
      }
    }

    if (!result && this.fuzzyPrefixSearch) {
      result = await this.lookupQueryPrefix(url);
    }

    if (!result) {
      return null;
    }

    await this.loadPayload(result);

    const status = result.status;
    const statusText = result.statusText || STATUS_CODES[status];
    const headers = makeHeaders(result.respHeaders);

    const date = new Date(result.ts);

    const payload = !isNullBodyStatus(status) ? result.payload : null;

    const response = new Response(payload, {status, statusText, headers});

    const extraOpts = result.extraOpts || null;

    return {url, response, date, noRW: false, extraOpts};
  }

  async loadPayload(result) {
    if (result.digest && !result.payload) {
      const { payload } = await this.db.get("payload", result.digest);
      result.payload = payload;
      if (!result.payload) {
        console.log("Missing payload for: " + result.digest);
      }
    }
  }

  async lookupFuzzyUrl(url) {
    return this.db.get("fuzzy", url);
  }

  async lookupUrl(url, datetime, skip = 0) {
    const tx = this.db.transaction("resources", "readonly");

    if (skip > 0) {
      console.log(`Skip ${skip} for ${url}`);
    }

    if (datetime) {
      const res = await tx.store.get([url, datetime]);
      if (res) {
        return res;
      }
    }

    let lastValue = null;

    for await (const cursor of tx.store.iterate(this.getLookupRange(url))) {
      if (lastValue && cursor.value.ts > datetime) {
        if (skip == 0) {
          const diff = cursor.value.ts - datetime;
          const diffLast = datetime - lastValue.ts;
          return diff < diffLast ? cursor.value : lastValue;
        } else {
          skip--;
        }
      }
      lastValue = cursor.value;
    }

    return lastValue;
  }

  // experimental
  async lookupQueryPrefix(url) {
    const tx = this.db.transaction("resources", "readonly");

    let results = [];

    let urlNoQ = url.split("?", 1)[0] + "?";

    for await (const cursor of tx.store.iterate(this.getLookupRange(urlNoQ, "prefix"))) {
      results.push(cursor.value);
    }

    if (!results.length) {
      return null;
    }

    const result = fuzzyCompareUrls(url, results);
    if (result) {
      console.log(`Fuzz: ${result.result.url} <-> ${url}`);
    }
    return result.result;
  }


  async resourcesByPage(pageId) {
    return this.db.getAllFromIndex("resources", "pageId", pageId);
  }

  async deletePageResources(pageId) {
    const digestSet = {};

    const tx = this.db.transaction("resources", "readwrite");

    let cursor = await tx.store.index("pageId").openCursor(pageId);

    let size = 0;

    while (cursor) {
      const digest = cursor.value.digest;
      if (digest) {
        digestSet[digest] = (digestSet[digest] || 0) + 1;
      } else if (cursor.value.payload) {
        size += cursor.value.payload.length;
      }

      tx.store.delete(cursor.primaryKey);

      cursor = await cursor.continue();
    }

    await tx.done;

    // delete payloads
    const tx2 = this.db.transaction(["payload", "digestRef"], "readwrite");
    const digestRefStore = tx2.objectStore("digestRef");

    for (const digest of Object.keys(digestSet)) {
      const ref = await digestRefStore.get(digest);

      if (ref) {
        ref.count -= digestSet[digest];
      }

      if (ref && ref.count >= 1) {
        digestRefStore.put(ref);
      } else {
        size += ref.size;
        digestRefStore.delete(digest);
        tx2.objectStore("payload").delete(digest);
      }
    }

    await tx2.done;
    return size;
  }

  getLookupRange(url, type) {
    switch (type) {
      case "prefix":
        let upper = url;
        upper = upper.slice(0, -1) + String.fromCharCode(url.charCodeAt(url.length - 1) + 1);
        return IDBKeyRange.bound([url], [upper], false, true);

      case "host":
        const origin = new URL(url).origin;
        return IDBKeyRange.bound([origin + "/"], [origin + "0"], false, true);

      case "exact":
      default:
        return IDBKeyRange.bound([url], [url + "!"], false, true);
    }
  }
}

// ===========================================================================
class RepeatTracker {
  constructor() {
    this.repeats = {};
  }

  getSkipCount(event, url, method) {
    if (method !== "POST") {
      return 0;
    }

    if (event.replacesClientId) {
      delete this.repeats[event.replacesClientId];
    }

    const id = event.resultingClientId || event.clientId;
    if (!id) {
      return 0;
    }

    if (this.repeats[id] === undefined) {
      this.repeats[id] = {};
    }

    if (this.repeats[id][url] === undefined) {
      this.repeats[id][url] = 0;
    } else {
      this.repeats[id][url]++;
    }

    return this.repeats[id][url];
  }
}


export { ArchiveDB };

