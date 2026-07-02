// Timeline tile renderer: UICollectionView-style pooled, recycled,
// transform-positioned containers. Owns no transcript semantics — callers
// describe the needed tiles per frame (key, position, contentKey, fill) and
// the pool mounts, moves, recycles, and refills the minimum set of nodes.
// ES2020, classic script: exposes window.TimelineRenderer.
(function () {
  "use strict";

  function createTilePool(container, options) {
    const opts = options || {};
    const poolLimit = typeof opts.poolLimit === "number" ? opts.poolLimit : 150;
    const tileClassName = opts.tileClassName || "timeline-tile";
    const mounted = new Map();
    const pool = [];
    let fillCount = 0;

    function createTile() {
      const el = document.createElement("div");
      el.className = tileClassName;
      return el;
    }

    function release(record) {
      record.el.style.display = "none";
      if (opts.clearOnRelease) record.el.innerHTML = "";
      if (pool.length < poolLimit) {
        pool.push(record.el);
      } else {
        record.el.remove();
      }
    }

    // specs: [{ key, x, y, width, height, contentKey, fill(el) }]
    // width/height of null/undefined are left unset (auto).
    function sync(specs) {
      const neededByKey = new Map();
      for (let i = 0; i < specs.length; i += 1) neededByKey.set(specs[i].key, specs[i]);
      const active = document.activeElement;
      const exited = [];
      mounted.forEach(function (record, key) {
        if (neededByKey.has(key)) return;
        // Never recycle the tile holding keyboard focus; it is dropped on a
        // later sync once focus moves.
        if (active && record.el.contains(active)) return;
        exited.push(key);
      });
      for (let i = 0; i < exited.length; i += 1) {
        const record = mounted.get(exited[i]);
        mounted.delete(exited[i]);
        release(record);
      }
      neededByKey.forEach(function (spec, key) {
        let record = mounted.get(key);
        if (!record) {
          const el = pool.pop() || createTile();
          el.style.display = "";
          if (el.parentNode !== container) container.appendChild(el);
          record = { key: key, el: el, contentKey: null, x: null, y: null, width: null, height: null };
          mounted.set(key, record);
        }
        if (record.x !== spec.x || record.y !== spec.y) {
          record.x = spec.x;
          record.y = spec.y;
          record.el.style.transform = "translate3d(" + spec.x + "px," + spec.y + "px,0)";
        }
        if (spec.width != null && record.width !== spec.width) {
          record.width = spec.width;
          record.el.style.width = spec.width + "px";
        }
        if (spec.height != null && record.height !== spec.height) {
          record.height = spec.height;
          record.el.style.height = spec.height + "px";
        }
        if (record.contentKey !== spec.contentKey) {
          record.contentKey = spec.contentKey;
          fillCount += 1;
          spec.fill(record.el);
        }
      });
    }

    function forEachMounted(fn) {
      mounted.forEach(function (record) {
        fn(record.el, record.key);
      });
    }

    function clear() {
      mounted.forEach(release);
      mounted.clear();
    }

    function stats() {
      return { mounted: mounted.size, pooled: pool.length, fills: fillCount };
    }

    return { sync: sync, forEachMounted: forEachMounted, clear: clear, stats: stats };
  }

  window.TimelineRenderer = { createTilePool: createTilePool };
})();
