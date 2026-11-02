import { expect, test } from "@playwright/test";

const listing = (id: string, title: string, price: string) => ({ id, title, price, size: "70 m²", address: "Ehrenfeld, Köln", url: "https://example.com/" + id });

test("Setup, Übersicht, Freigabe, Filter – Desktop und Handy", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("Passwort").fill("e2e-passwort-123");
  await page.getByRole("button", { name: "Einrichten" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();

  // Profil anlegen (wird automatisch aktiv)
  await expect(page.getByRole("link", { name: "Fredy öffnen" })).toHaveAttribute("href", /:9998\/$/); // Link zur Fredy-Oberfläche
  await page.getByRole("link", { name: "Profil" }).click();
  await page.getByLabel("Name (so unterschreibst du)").fill("Max Muster");
  await page.getByLabel("Beruf").fill("Videograf");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status")).toContainText("Gespeichert");

  // Filter setzen, dann Ingest: eines passt, eines nicht.
  await page.getByRole("link", { name: "Suchen" }).click();
  await page.getByLabel("Max. Miete (€ warm)").fill("1000");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status")).toContainText("Gespeichert");

  // Umkreis-Bedienung (nicht gespeichert, kein Netzwerk): Chip setzt den Radius, Schieberegler folgt
  await page.getByLabel("Mittelpunkt (Adresse)").fill("Neumarkt, Köln");
  await page.getByRole("button", { name: "5 km" }).click();
  await expect(page.getByText("Radius: 5 km")).toBeVisible();
  await page.screenshot({ path: "e2e/shots/searches-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "e2e/shots/searches-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });

  const res = await request.post("/api/ingest", {
    headers: { authorization: "Bearer e2e-ingest-token-123456" },
    data: { provider: "immoscout", listings: [listing("1", "Helle 3-Zimmer-Wohnung", "900 €"), listing("2", "Teure Wohnung", "1.800 €")] },
  });
  expect(await res.json()).toEqual({ inserted: 2, duplicates: 0 });

  await page.getByRole("link", { name: "Übersicht" }).click();
  await expect(page.getByLabel("Neue Wohnungen heute: 2")).toBeVisible();
  await expect(page.getByLabel("Verworfen: 1")).toBeVisible();
  await page.screenshot({ path: "e2e/shots/overview-desktop.png", fullPage: true });

  await page.getByRole("link", { name: "Einstellungen" }).click();
  await expect(page.getByText("Die Session-Überwachung ist aus.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Telegram" })).toBeVisible();
  await expect(page.getByText("Noch nicht eingerichtet.")).toBeVisible();
  await expect(page.locator("form", { has: page.getByLabel("Bot-Token") }).getByRole("button", { name: "Speichern" })).toBeDisabled(); // ohne Token und Chat-ID
  await expect(page.getByRole("heading", { name: "Fredy-Details" })).toBeVisible();
  await page.screenshot({ path: "e2e/shots/settings-desktop.png", fullPage: true });

  await page.getByRole("link", { name: "Freigaben" }).click();
  await expect(page.getByText("1 von 1")).toBeVisible();
  const editor = page.getByLabel("Nachricht an den Vermieter");
  await expect(editor).toContainText("Max Muster"); // Auto-Entwurf aus dem Template
  await editor.fill((await editor.inputValue()) + " Zusatz von mir.");
  await page.screenshot({ path: "e2e/shots/review-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "e2e/shots/review-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); // kein Horizontal-Scroll

  await page.getByRole("button", { name: "Senden" }).click();
  await expect(page.getByText("Nichts zu prüfen.")).toBeVisible();
  const approved = await (await request.get("/api/listings?state=freigegeben", { headers: { cookie: (await page.context().cookies()).map((c) => c.name + "=" + c.value).join("; ") } })).json();
  expect(approved.items).toHaveLength(1);

  await page.getByRole("link", { name: "Verlauf" }).click();
  await expect(page.getByText("Wartet", { exact: true })).toBeVisible(); // freigegeben, liegt in der Queue
  await expect(page.getByText("Noch keine Sendeversuche.")).toBeVisible();

  await page.getByRole("link", { name: "Übersicht" }).click();
  await page.getByRole("button", { name: "Auto" }).click();
  await expect(page.getByText("max. 7 pro Tag und Portal")).toBeVisible();
  await expect(page.getByText("Dry-Run: es wird nichts gesendet")).toBeVisible();
  await page.screenshot({ path: "e2e/shots/overview-auto.png", fullPage: true });
});
