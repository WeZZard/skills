import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getSiteBuildingWindow } from "./site-building-window.mjs";

const at = (time) => new Date(`2026-07-22T${time}:00+08:00`);

describe("site-building pricing window", () => {
  for (const time of ["00:00", "07:59", "12:00", "12:59", "18:00", "23:59"]) {
    it(`allows ${time} Asia/Taipei`, () => {
      assert.equal(getSiteBuildingWindow(at(time)).allowed, true);
    });
  }

  for (const time of ["08:00", "08:59", "09:00", "11:59", "13:00", "13:59", "14:00", "17:59"]) {
    it(`refuses ${time} Asia/Taipei`, () => {
      assert.equal(getSiteBuildingWindow(at(time)).allowed, false);
    });
  }
});
