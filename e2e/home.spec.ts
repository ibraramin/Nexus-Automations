import { expect, test } from "@playwright/test";

/** The static export must still render the recruiter-facing home page. */
test("shipped static home page renders the H1 and both hero CTAs", async ({ page }) => {
  await page.goto("/");

  const hero = page.locator("section").filter({ has: page.locator("h1") });
  await expect(hero).toHaveCount(1);
  const h1 = hero.locator("h1");
  await expect(h1).toContainText("Automation for small businesses, built around your workflow");
  await expect(h1).toContainText("delivered in your timezone.");
  await expect(hero.getByRole("link", { name: /Free automation audit/ })).toHaveAttribute(
    "href",
    "/contact",
  );
  await expect(hero.getByRole("link", { name: /Try a live demo/ })).toHaveAttribute("href", "/demos");
});

test.describe("home page stat counters", () => {
  // Keep the hero stats below the fold so the scroll-triggered counts are real.
  test.use({ viewport: { width: 1280, height: 600 } });

  test("settle to <5 min and 2 wks only after scrolling into view", async ({ page }) => {
    await page.goto("/");

    // CountUp renders <span>{prefix}{display}{suffix}</span>; `display` starts at 0.
    const counters = page.locator("dl dd.font-mono > span");
    await expect(counters).toHaveCount(3);
    expect(await page.locator("dl dt.sr-only").allTextContents()).toEqual([
      "typical hours saved per week",
      "typical lead response time",
      "typical time to go live",
    ]);

    const leadResponse = counters.nth(1);
    const goLive = counters.nth(2);

    // Before scroll: the values have not been counted up yet.
    await expect(leadResponse).toHaveText("<0 min");
    await expect(goLive).toHaveText("0 wks");

    await leadResponse.scrollIntoViewIfNeeded();

    // After scroll: the shipped counters have settled on the displayed values.
    await expect(leadResponse).toHaveText("<5 min");
    await expect(goLive).toHaveText("2 wks");
    await expect(counters.nth(0)).toHaveText("10+");
  });
});
