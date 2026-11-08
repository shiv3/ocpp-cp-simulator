// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LanguageToggle from "../components/LanguageToggle";
import { LOCALE_STORAGE_KEY, getLocale, setLocale, t } from "./index";

afterEach(async () => {
  cleanup();
  await setLocale("en");
  window.localStorage.clear();
});

describe("LanguageToggle", () => {
  it("switches language, persists it and sets <html lang>", async () => {
    const user = userEvent.setup();
    render(<LanguageToggle />);
    await user.click(screen.getByRole("button", { name: "Change language" }));
    await user.click(await screen.findByRole("menuitem", { name: /日本語/ }));
    // the trigger label itself re-renders in the new language (loaded lazily)
    expect(
      await screen.findByRole("button", { name: "言語を変更" }),
    ).toBeTruthy();
    expect(getLocale()).toBe("ja");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");
    expect(t("common.theme.dark")).toBe("ダーク");
  });

  it("offers French in the picker", async () => {
    const user = userEvent.setup();
    render(<LanguageToggle />);
    await user.click(screen.getByRole("button", { name: "Change language" }));
    await user.click(await screen.findByRole("menuitem", { name: /Français/ }));
    expect(
      await screen.findByRole("button", { name: "Changer de langue" }),
    ).toBeTruthy();
    expect(getLocale()).toBe("fr");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");
  });

  it("renders singular and plural forms per language", async () => {
    await setLocale("ja");
    expect(t("settings.page.tagsActive", { count: 1 })).toBe(
      t("settings.page.tagsActive", { count: 2 }).replace("2", "1"),
    );
    // French uses the singular for 0 as well as 1
    await setLocale("fr");
    expect(document.documentElement.lang).toBe("fr");
    expect(t("scenarios.count.step", { count: 0 })).toBe("0 étape");
    expect(t("scenarios.count.step", { count: 1 })).toBe("1 étape");
    expect(t("scenarios.count.step", { count: 2 })).toBe("2 étapes");
    // 1,000,000 falls in the "many" plural category in French
    expect(new Intl.PluralRules("fr").select(1_000_000)).toBe("many");
    expect(t("scenarios.count.step", { count: 1_000_000 })).toBe(
      "1000000 étapes",
    );
    await setLocale("en");
    expect(t("scenarios.count.step", { count: 1 })).toBe("1 step");
    expect(t("scenarios.count.step", { count: 3 })).toBe("3 steps");
  });
});
