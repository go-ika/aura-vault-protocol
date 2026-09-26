import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Keeper Harvest Flow — E2E Test
//
// Covers the full keeper harvest lifecycle:
//   1. Navigate to /harvest
//   2. Connect keeper wallet via Freighter (mocked)
//   3. Trigger harvest
//   4. Wait for transaction confirmation
//   5. Assert share price increased
//   6. Assert harvest event appears in transaction history
//
// Maximum test duration: 60 seconds (test.setTimeout enforced below)
// Runs against PLAYWRIGHT_BASE_URL (staging in CI, localhost:3000 locally)
// ---------------------------------------------------------------------------

/** Initial share price returned by the first vault/stats mock response. */
const INITIAL_SHARE_PRICE = "1050000"; // 1.05 tokens/share (scaled to 7 decimals)

/** Elevated share price returned after harvest. */
const POST_HARVEST_SHARE_PRICE = "1090500"; // 1.0905 tokens/share — ~4% yield event

/** Mock transaction hash for the harvest operation. */
const MOCK_TX_HASH =
  "3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4";

test.describe("Keeper harvest flow", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    // ------------------------------------------------------------------
    // Inject Freighter wallet mock — must be done before page navigation
    // so the script is available when the page initialises its wallet hooks.
    // ------------------------------------------------------------------
    await page.addInitScript(() => {
      (window as any).freighterApi = {
        isConnected: async () => true,
        getPublicKey: async () => "GKEEPER1234567890TESTPUBLICKEYABCDEFGHIJKLMNOPQRSTUVWXYZ",
        getNetwork: async () => "TESTNET",
        signTransaction: async (_xdr: string) => "signed_harvest_xdr_mock",
        getNetworkDetails: async () => ({
          network: "TESTNET",
          networkPassphrase: "Test SDF Network ; September 2015",
          networkUrl: "https://horizon-testnet.stellar.org",
          sorobanRpcUrl: "https://soroban-testnet.stellar.org",
        }),
      };
    });

    // ------------------------------------------------------------------
    // Stub vault API routes
    // ------------------------------------------------------------------

    // Vault stats — initial state (before harvest)
    let harvestTriggered = false;
    await page.route("**/api/v1/vault/stats", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            totalAssets: harvestTriggered ? "10905000" : "10500000",
            totalShares: "10000000",
            pricePerShare: harvestTriggered
              ? POST_HARVEST_SHARE_PRICE
              : INITIAL_SHARE_PRICE,
            lastHarvestAt: harvestTriggered
              ? new Date().toISOString()
              : "2026-09-25T10:00:00.000Z",
          },
          meta: { timestamp: new Date().toISOString() },
        }),
      });
    });

    // Vault total_assets (legacy endpoint used by some components)
    await page.route("**/api/vault/total_assets*", (r) =>
      r.fulfill({ status: 200, json: { total: "10500000" } })
    );

    // Vault balance_of
    await page.route("**/api/vault/balance_of*", (r) =>
      r.fulfill({ status: 200, json: { balance: "5000000" } })
    );

    // Harvest endpoint — POST triggers harvest on-chain
    await page.route("**/api/v1/vault/harvest", async (route) => {
      if (route.request().method() === "POST") {
        // Mark harvest as complete so subsequent stats calls return new price
        harvestTriggered = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              txHash: MOCK_TX_HASH,
              yieldAmount: "405000",
              newTotalAssets: "10905000",
              newPricePerShare: POST_HARVEST_SHARE_PRICE,
            },
            meta: { timestamp: new Date().toISOString() },
          }),
        });
      } else {
        await route.continue();
      }
    });

    // Transaction history — returns a harvest entry after the operation
    await page.route("**/api/v1/vault/transactions*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: harvestTriggered
            ? [
                {
                  type: "harvest",
                  txHash: MOCK_TX_HASH,
                  amount: "405000",
                  timestamp: new Date().toISOString(),
                  status: "confirmed",
                },
              ]
            : [],
          pagination: {
            page: 1,
            pageSize: 20,
            total: harvestTriggered ? 1 : 0,
            totalPages: harvestTriggered ? 1 : 0,
            hasNext: false,
            hasPrev: false,
          },
          meta: { timestamp: new Date().toISOString() },
        }),
      });
    });
  });

  test("keeper navigates to harvest page, triggers harvest, and share price increases", async ({
    page,
  }) => {
    // ----------------------------------------------------------------
    // Step 1: Navigate to /harvest
    // ----------------------------------------------------------------
    await page.goto("/harvest");

    // Verify we are on the harvest page
    await expect(page).toHaveURL(/harvest/i);

    // ----------------------------------------------------------------
    // Step 2: Connect the keeper wallet
    // ----------------------------------------------------------------
    await expect(page.getByTestId("connect-wallet-btn")).toBeVisible({
      timeout: 10_000,
    });

    await page.getByTestId("connect-wallet-btn").click();

    // Wallet address should appear in the header after connection
    await expect(page.getByTestId("wallet-address")).toBeVisible({
      timeout: 10_000,
    });

    // Network badge confirms TESTNET
    await expect(page.getByTestId("network-badge")).toContainText(/TESTNET/i, {
      timeout: 5_000,
    });

    // ----------------------------------------------------------------
    // Step 3: Capture initial share price for later comparison
    // ----------------------------------------------------------------
    const priceLocator = page.getByTestId("price-per-share");
    await expect(priceLocator).toBeVisible({ timeout: 10_000 });

    const initialPriceText = await priceLocator.textContent();
    expect(initialPriceText).toBeTruthy();

    // ----------------------------------------------------------------
    // Step 4: Click "Trigger Harvest"
    // ----------------------------------------------------------------
    const triggerBtn = page.getByTestId("trigger-harvest-btn");
    await expect(triggerBtn).toBeVisible({ timeout: 10_000 });
    await expect(triggerBtn).toBeEnabled();

    await triggerBtn.click();

    // ----------------------------------------------------------------
    // Step 5: Freighter mock auto-confirms — wait for transaction
    //         confirmation indicator to appear in the UI.
    //
    //         The component should show a confirmation toast, status
    //         badge, or dedicated confirmation element.
    // ----------------------------------------------------------------
    const txConfirmation = page
      .getByTestId("tx-confirmation")
      .or(page.getByTestId("harvest-success"))
      .or(page.getByText(/harvest.*confirmed/i))
      .or(page.getByText(/transaction.*confirmed/i))
      .first();

    await expect(txConfirmation).toBeVisible({ timeout: 30_000 });

    // ----------------------------------------------------------------
    // Step 6: Assert share price has increased
    //
    //         The price-per-share display should show a value strictly
    //         greater than the initial price. We compare numeric content.
    // ----------------------------------------------------------------
    // Wait for UI to refresh with post-harvest stats
    await page.waitForTimeout(1_000); // brief settle for any polling cycle

    const updatedPriceText = await priceLocator.textContent();
    expect(updatedPriceText).toBeTruthy();

    // Extract numeric values for comparison (strip non-numeric except '.')
    const parsePrice = (text: string | null): number => {
      if (!text) return 0;
      const match = text.match(/[\d.]+/);
      return match ? parseFloat(match[0]) : 0;
    };

    const initialPrice = parsePrice(initialPriceText);
    const updatedPrice = parsePrice(updatedPriceText);

    expect(updatedPrice).toBeGreaterThan(initialPrice);

    // ----------------------------------------------------------------
    // Step 7: Assert harvest event appears in transaction history
    // ----------------------------------------------------------------
    const txHistorySection = page
      .getByTestId("transaction-history")
      .or(page.getByRole("region", { name: /transaction history/i }))
      .first();

    await expect(txHistorySection).toBeVisible({ timeout: 10_000 });

    // Harvest entry must be present
    await expect(
      txHistorySection
        .getByText(/harvest/i)
        .or(txHistorySection.getByTestId("tx-type-harvest"))
        .first()
    ).toBeVisible({ timeout: 10_000 });

    // Transaction hash should be visible (full or truncated)
    const txHashPreview = MOCK_TX_HASH.slice(0, 8);
    await expect(
      txHistorySection.getByText(new RegExp(txHashPreview, "i")).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("harvest button is disabled when wallet is not connected", async ({
    page,
  }) => {
    await page.goto("/harvest");

    // The trigger button should either be absent or disabled without a wallet
    const triggerBtn = page.getByTestId("trigger-harvest-btn");

    // Either the button is hidden or it is disabled — both are acceptable
    const isVisible = await triggerBtn.isVisible().catch(() => false);
    if (isVisible) {
      await expect(triggerBtn).toBeDisabled();
    }
    // If not visible, the test passes — the UI requires wallet connection first
  });

  test("harvest page loads without errors when not connected", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/harvest");

    await expect(page).toHaveURL(/harvest/i);
    await expect(page.locator("body")).toBeVisible();

    // No uncaught JavaScript errors on page load
    expect(errors).toHaveLength(0);
  });
});
