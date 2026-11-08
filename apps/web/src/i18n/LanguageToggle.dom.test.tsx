// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LanguageToggle from "../components/LanguageToggle";
import { LOCALE_STORAGE_KEY, getLocale, setLocale, t } from "./index";

afterEach(() => {
  cleanup();
  setLocale("en");
  window.localStorage.clear();
});

describe("LanguageToggle", () => {
  it("switches language, persists it and sets <html lang>", async () => {
    const user = userEvent.setup();
    render(<LanguageToggle />);
    await user.click(screen.getByRole("button", { name: "Change language" }));
    await user.click(await screen.findByRole("menuitem", { name: /日本語/ }));
    expect(getLocale()).toBe("ja");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");
    expect(t("common.theme.dark")).toBe("ダーク");
    // the trigger label itself re-renders in the new language
    expect(screen.getByRole("button", { name: "言語を変更" })).toBeTruthy();
  });
});
