// tests/e2e/general_chat.spec.js — UI-CHAT-01 .. UI-CHAT-03
import { test, expect } from '@playwright/test';
import { loginAs, sendMessage } from './helpers/auth.js';

test.describe('UI-CHAT — General Chat', () => {

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('UI-CHAT-01 — Send a basic message', async ({ page }) => {
    await sendMessage(page, 'What is machine learning?');

    // Assert user message bubble
    const userMsg = page.locator('.user-message, [class*="user-message"]').last();
    await expect(userMsg).toBeVisible({ timeout: 5000 });

    // Assert bot response bubble
    const botMsg = page.locator('.message-bubble, [class*="message-bubble"], [class*="items-start"] .message-bubble-wrapper').last();
    await expect(botMsg).toBeVisible({ timeout: 60000 });

    // Assert response has text
    const text = await botMsg.textContent();
    expect(text.length).toBeGreaterThan(20);

    console.log('✓ UI-CHAT-01 passed: Message sent and response received');
  });

  test('UI-CHAT-02 — Multi-turn conversation context', async ({ page }) => {
    await sendMessage(page, 'Explain overfitting in machine learning');

    // Second message referencing previous context
    await sendMessage(page, 'Give me an example of what you described');

    // Bot response should exist
    const botMsgs = page.locator('.message-bubble, [class*="message-bubble"], [class*="items-start"] .message-bubble-wrapper');
    const count = await botMsgs.count();
    expect(count).toBeGreaterThanOrEqual(2);

    console.log(`✓ UI-CHAT-02 passed: ${count} bot messages in conversation`);
  });

  test('UI-CHAT-03 — New chat clears messages', async ({ page }) => {
    await sendMessage(page, 'Hello, explain recursion');

    // Click "New Chat"
    const newChatBtn = page.getByRole('button', { name: /new chat/i })
      .or(page.getByTitle(/new chat/i));
    await newChatBtn.click();

    await page.waitForTimeout(2000);

    // Assert chat area is empty (no bot messages) or welcome shown
    const welcome = page.locator('[data-testid="center-panel-welcome"]');
    const botMsgs = page.locator('.message-bubble, [class*="message-bubble"]');
    const botCount = await botMsgs.count();

    // Either welcome is visible or no bot messages
    const isCleared = botCount === 0 || await welcome.isVisible().catch(() => false);
    expect(isCleared).toBeTruthy();

    console.log('✓ UI-CHAT-03 passed: New chat cleared messages');
  });

});
