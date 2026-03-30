import { test } from "@playwright/test";

test.describe("front-end smoke journeys", () => {
  test("auth unlock and shell access", async ({ page }) => {
    test.skip();
    await page.goto("/");
  });

  test("template deploy and app lifecycle actions", async ({ page }) => {
    test.skip();
    await page.goto("/apps/templates");
  });

  test("files flow and settings passcode flow", async ({ page }) => {
    test.skip();
    await page.goto("/files");
  });
});
