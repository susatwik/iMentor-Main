// tests/e2e/helpers/auth.js
// Shared login helper for all E2E tests

/**
 * Login as the test user and return the authenticated page
 */
export async function loginAs(page, email = 'ultra.boy7@gmail.com', password = '123456') {
  await page.goto('/');

  // We land on LandingPage when not authenticated
  // Click the hero 'Sign In' or 'Login' button in the nav
  const loginBtn = page.getByRole('button', { name: /sign.?in|login/i }).first();
  await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
  await loginBtn.click();

  // Fill the auth modal
  await page.getByPlaceholder(/email/i).fill(email);
  await page.getByPlaceholder(/password/i).fill(password);

  // Click the submit button (Sign In / Login) — inside the form to avoid strict-mode
  await page.locator('form').getByRole('button', { name: /sign.?in|login/i }).click();

  // Wait for auth modal to close: the email input inside the modal disappears
  await page.waitForSelector('input[placeholder*="Email Address"]', { state: 'hidden', timeout: 25000 });

  // Wait for the main chat input to appear and be enabled (app fully loaded)
  await page.waitForSelector('textarea:not([disabled])', { timeout: 25000 });

  // Extra buffer for session creation async work
  await page.waitForTimeout(300);
}

/**
 * Send a chat message and wait for bot response
 */
export async function sendMessage(page, text, waitMs = 60000) {
  // The textarea has rotating placeholders; match broadly or fall back to textarea
  const input = page.locator('textarea:visible').first();
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.fill(text);

  // Press Enter or click Send
  const sendBtn = page.getByTitle(/send message/i).or(page.getByRole('button', { name: /send/i }));
  if (await sendBtn.isVisible()) {
    await sendBtn.click();
  } else {
    await input.press('Enter');
  }

  // Wait for bot response bubble to appear
  // Actual class is .message-bubble (not .bot-message), inside a .items-start wrapper for bot msgs
  await page.waitForSelector('.message-bubble, [class*="message-bubble"], [class*="items-start"] .message-bubble-wrapper', {
    timeout: waitMs,
  });

  // Wait for streaming to finish (cursor disappears)
  try {
    await page.waitForSelector('.streaming-cursor', { state: 'hidden', timeout: waitMs });
  } catch {
    // Cursor might have disappeared already
  }

  // Small settle time
  await page.waitForTimeout(1000);
}
