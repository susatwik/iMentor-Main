// tests/e2e/auth.spec.js — UI-AUTH-01, UI-AUTH-02
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';

test.describe('UI-AUTH — Authentication Flow', () => {

  test('UI-AUTH-01 — Login and reach main chat', async ({ page }) => {
    await page.goto('/');

    // Assert landing page visible
    await expect(page.locator('body')).toBeVisible();

    // Click Sign In (nav button)
    const loginBtn = page.getByRole('button', { name: /sign.?in|login/i }).first();
    await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
    await loginBtn.click();

    // Fill credentials
    await page.getByPlaceholder(/email/i).fill('ultra.boy7@gmail.com');
    await page.getByPlaceholder(/password/i).fill('123456');
    await page.locator('form').getByRole('button', { name: /sign.?in|login/i }).click();

    // URL stays at '/' — wait for modal to close (email field disappears)
    await page.waitForSelector('input[placeholder*="email" i]', { state: 'hidden', timeout: 20000 });

    // Assert chat input or main UI is present
    const chatInput = page.locator('textarea').or(page.locator('[data-tutor-tour="chat-input"]')).first();
    await expect(chatInput).toBeVisible({ timeout: 15000 });

    // Assert TopNav visible
    await expect(page.locator('nav, header').first()).toBeVisible();

    console.log('✓ UI-AUTH-01 passed: Login successful, chat interface visible');
  });

  test('UI-AUTH-02 — Login with wrong password shows error', async ({ page }) => {
    await page.goto('/');

    const loginBtn = page.getByRole('button', { name: /sign.?in|login/i }).first();
    await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
    await loginBtn.click();

    await page.getByPlaceholder(/email/i).fill('ultra.boy7@gmail.com');
    await page.getByPlaceholder(/password/i).fill('wrongpassword');
    await page.locator('form').getByRole('button', { name: /sign.?in|login/i }).click();

    // Assert error message appears — AuthModal shows inline div + toast
    // Inline error has bg-gray-900 border border-white (no "error" class name)
    // Match by text content which is "Invalid email address or password."
    const errorEl = page.getByText(/invalid|incorrect|wrong|error/i).first();
    await expect(errorEl).toBeVisible({ timeout: 10000 });

    console.log('✓ UI-AUTH-02 passed: Error shown for wrong password');
  });

});
