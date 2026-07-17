// tests/e2e/helpers/auth.js
// Shared login helper for all E2E tests

const BASE_API = 'http://localhost:5001/api';

/**
 * Login as the test user and return the authenticated page.
 * Auto-creates the user via the signup API if login fails.
 */
export async function loginAs(page, email = 'ultra.boy7@gmail.com', password = '123456') {
  await page.goto('/');

  // Click the hero 'Sign In' or 'Login' button in the nav
  const loginBtn = page.getByRole('button', { name: /sign.?in|login/i }).first();
  await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
  await loginBtn.click();

  // Fill the auth modal
  await page.getByPlaceholder(/email/i).fill(email);
  await page.getByPlaceholder(/password/i).fill(password);

  // Click the submit button (Sign In / Login)
  await page.locator('form').getByRole('button', { name: /sign.?in|login/i }).click();

  // If login fails (error shown), create the user via API and retry
  const loginFailed = await page.getByText(/invalid email|already exists/i).isVisible({ timeout: 5000 }).catch(() => false);

  if (loginFailed) {
    console.log(`[auth.js] User ${email} not found, signing up via API...`);

    // Step 1: send-otp (dev mode creates PendingRegistration with OTP 123456)
    const otpResp = await page.request.post(`${BASE_API}/auth/send-otp`, {
      data: { email, password },
    });
    if (!otpResp.ok() && (await otpResp.json()).message?.includes('already exists')) {
      console.log(`[auth.js] User ${email} already exists, retrying login...`);
    } else if (!otpResp.ok()) {
      throw new Error(`send-otp failed: ${await otpResp.text()}`);
    } else {
      // Step 2: signup with full profile (dev mode skips verify-otp)
      const signupResp = await page.request.post(`${BASE_API}/auth/signup`, {
        data: {
          email, otp: '123456', password,
          name: 'Test User',
          college: 'Test University',
          universityNumber: 'TEST001',
          degreeType: "Bachelor's",
          branch: 'Computer Science',
          year: '1st Year',
          learningStyle: 'Reading/Writing',
          currentGoals: 'E2E testing',
          preferredLlmProvider: 'local_llm',
        },
      });
      if (signupResp.ok()) {
        console.log(`[auth.js] User ${email} created successfully`);
      } else {
        const body = await signupResp.json();
        console.log(`[auth.js] Signup note: ${body.message}`);
      }
    }

    // Close the failed login modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Re-open sign-in modal and login again
    const retryBtn = page.getByRole('button', { name: /sign.?in|login/i }).first();
    await retryBtn.waitFor({ state: 'visible', timeout: 10000 });
    await retryBtn.click();
    await page.waitForTimeout(300);

    await page.getByPlaceholder(/email/i).fill(email);
    await page.getByPlaceholder(/password/i).fill(password);
    await page.locator('form').getByRole('button', { name: /sign.?in|login/i }).click();
  }

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
