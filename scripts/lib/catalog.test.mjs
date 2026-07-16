import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { selectTagSha } from "./catalog.mjs";

// These run against a throwaway local repo rather than fixture strings: the bug
// this guards was a wrong assumption about how ls-remote orders its output, and
// a fixture would just re-encode the assumption instead of testing it. A local
// path is a valid git remote, so ls-remote behaves exactly as it does over the
// network, without the network.
describe("selectTagSha", () => {
  let repo;
  let commit;

  function git(args) {
    return execSync(`git ${args}`, { cwd: repo, encoding: "utf8" }).trim();
  }

  function lsRemote(tag) {
    return execSync(`git ls-remote "${repo}" "refs/tags/${tag}^{}" "refs/tags/${tag}"`, {
      encoding: "utf8",
    }).trim();
  }

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "catalog-test-"));
    git("init -q -b main");
    git('config user.email "test@example.com"');
    git('config user.name "Catalog Test"');
    git('commit -q --allow-empty -m "initial"');
    commit = git("rev-parse HEAD");
    git("tag v1-lightweight");
    git('tag -a v1-annotated -m "annotated release"');
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("resolves a lightweight tag to its commit", () => {
    assert.equal(selectTagSha(lsRemote("v1-lightweight")), commit);
  });

  it("resolves an annotated tag to its commit, not its tag object", () => {
    const tagObject = git("rev-parse v1-annotated");
    assert.notEqual(tagObject, commit, "precondition: the tag object differs from the commit");
    assert.equal(selectTagSha(lsRemote("v1-annotated")), commit);
  });

  // Pins the trap the implementation exists to avoid: ls-remote hands back the
  // unpeeled ref first even though `^{}` is passed first on the command line, so
  // reading line [0] would pin the tag object. If a future git reorders this,
  // this test says so plainly instead of letting a wrong SHA reach a pin.
  it("lists the unpeeled ref before its peel for an annotated tag", () => {
    const lines = lsRemote("v1-annotated").split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].endsWith("refs/tags/v1-annotated"), "line 0 is the tag object");
    assert.ok(lines[1].endsWith("refs/tags/v1-annotated^{}"), "line 1 is the peeled commit");
  });

  it("returns a lightweight tag's only line as the commit", () => {
    const lines = lsRemote("v1-lightweight").split("\n");
    assert.equal(lines.length, 1, "a lightweight tag advertises no peeled ref");
  });
});
