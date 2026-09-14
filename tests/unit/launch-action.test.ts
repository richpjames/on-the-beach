import { describe, expect, test } from "bun:test";
import {
  buildLaunchActionHref,
  LAUNCH_ACTION_PARAM,
  parseLaunchAction,
} from "../../src/ui/logic/launch-action";
import { buildListSearch, defaultListViewState } from "../../src/ui/logic/list-url";

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("parseLaunchAction", () => {
  test("reads the listen action the native shell sets", () => {
    expect(parseLaunchAction(params("action=listen"))).toBe("listen");
  });

  test("ignores an absent, unknown or empty action", () => {
    expect(parseLaunchAction(params(""))).toBeNull();
    expect(parseLaunchAction(params("action="))).toBeNull();
    expect(parseLaunchAction(params("action=delete-everything"))).toBeNull();
    expect(parseLaunchAction(params("filter=listened"))).toBeNull();
  });

  test("survives alongside the browsing params", () => {
    expect(parseLaunchAction(params("filter=listened&action=listen&q=aphex"))).toBe("listen");
  });
});

describe("buildLaunchActionHref", () => {
  test("is the URL the widget and quick action open", () => {
    expect(buildLaunchActionHref("listen")).toBe("/?action=listen");
  });

  test("uses the param name the parser reads", () => {
    expect(buildLaunchActionHref("listen")).toContain(`${LAUNCH_ACTION_PARAM}=`);
  });
});

describe("the action param is a one-shot", () => {
  // The address bar is rewritten from the recognised browsing controls, so the
  // action drops out on the first sync — a reload can't fire it a second time.
  test("browsing state is serialised without it", () => {
    expect(buildListSearch(defaultListViewState(null), null)).toBe("");
    expect(buildListSearch({ ...defaultListViewState(null), search: "aphex" }, null)).toBe(
      "?q=aphex",
    );
  });
});
