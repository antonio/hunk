import { expect, test } from "bun:test";
import { parseBundleMetadata, parseBundleInvocation } from "./bundle";
const base = "1".repeat(40),
  head = "2".repeat(40);
const metadata = {
  repository: "acme/project",
  number: 7,
  url: "https://github.com/acme/project/pull/7",
  baseOid: base,
  headOid: head,
  mergeBaseOid: base,
};

test("reads the two observed bundle identity shapes without inferring a PR", () => {
  expect(parseBundleMetadata(metadata)).toEqual({
    repository: "acme/project",
    number: 7,
    url: metadata.url,
    base,
    head,
    mergeBase: base,
  });
  expect(
    parseBundleMetadata({
      repository: metadata.repository,
      number: 7,
      url: metadata.url,
      base_oid: base,
      head_oid: head,
      merge_base_oid: base,
    }),
  ).toEqual(parseBundleMetadata(metadata));
});
test("rejects ambiguous or malformed identities", () => {
  for (const change of [
    { head_oid: base },
    { headOid: "main" },
    { number: -1 },
    { repository: "../project" },
    { url: "https://evil.test/acme/project/pull/7" },
    { testMergeOid: "oops" },
  ]) {
    expect(() => parseBundleMetadata({ ...metadata, ...change })).toThrow();
  }
});
test("requires paired launcher guards and only presentation or sidecar options", () => {
  expect(
    parseBundleInvocation([
      "bundle",
      "--expect-base",
      base,
      "--expect-head",
      head,
      "--",
      "--agent-context",
      "notes.json",
    ]),
  ).toMatchObject({
    directory: "bundle",
    expectedBase: base,
    expectedHead: head,
    diffArgs: ["--agent-context", "notes.json"],
  });
  for (const args of [
    ["bundle", "--expect-head", head],
    ["bundle", "--", "--vcs", "jj"],
    ["bundle", "--", "main"],
    ["bundle", "--", "--watch"],
    ["bundle", "--expect-base", "main", "--expect-head", head],
  ])
    expect(() => parseBundleInvocation(args)).toThrow();
});
