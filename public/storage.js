/*
 * Claude 아티팩트 안에서는 window.storage가 이미 있지만,
 * 밖에서는 없다. 이미지가 들어 있어 localStorage(약 5MB)로는 금방 넘치므로
 * IndexedDB로 같은 모양의 인터페이스를 만들어 둔다.
 * 덕분에 app 쪽 코드는 한 줄도 고치지 않아도 된다.
 */
(function () {
  "use strict";
  if (window.storage) return;

  var DB = "capnote", STORE = "kv", dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var req = fn(t.objectStore(STORE));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  window.storage = {
    get: function (key) {
      return tx("readonly", function (s) { return s.get(key); }).then(function (v) {
        if (v === undefined) throw new Error("not found: " + key);
        return { key: key, value: v, shared: false };
      });
    },
    set: function (key, value) {
      return tx("readwrite", function (s) { return s.put(value, key); }).then(function () {
        return { key: key, value: value, shared: false };
      });
    },
    delete: function (key) {
      return tx("readwrite", function (s) { return s.delete(key); }).then(function () {
        return { key: key, deleted: true, shared: false };
      });
    },
    list: function (prefix) {
      return tx("readonly", function (s) { return s.getAllKeys(); }).then(function (keys) {
        return {
          keys: keys.filter(function (k) { return !prefix || String(k).indexOf(prefix) === 0; }),
          prefix: prefix,
          shared: false
        };
      });
    }
  };
})();
