// tests/e2e/helpers/chat-helpers.js
// Shared chat interaction helpers for E2E tests

const BASE_API = 'http://localhost:5005/api';

/* ─── Selectors ────────────────────────────────────────────────────── */

export const SEL = {
  // Chat input area
  chatInputContainer: '[data-tutor-tour="chat-input"]',
  textarea:           'textarea',
  plusButton:          'button[aria-label="More options"]',
  sendButton:         'button[title="Send message (Enter)"]',
  stopButton:         'button[title="Stop generating"]',

  // Desktop toggles (hidden on mobile via sm:flex)
  totToggle:          'button[aria-label="Toggle Tree of Thought"]',
  ragToggle:          'button[aria-label="Toggle RAG / Knowledge Base"]',
  promptCoach:        'button[aria-label="Prompt Coach"]',
  voiceInput:         'button[aria-label="Voice input"]',

  // Bot / user messages
  botMessage:         '.message-bubble, [class*="message-bubble"], [class*="items-start"] .message-bubble-wrapper',
  userMessage:        '.user-message, [class*="user-message"]',
  streamingCursor:    '.streaming-cursor',
  thinkingDropdown:   'details, [class*="thinking"], [class*="thought"]',

  // Status pills (below input)
  webSearchPill:      '[class*="status"] >> text=/web search/i',
  academicPill:       '[class*="status"] >> text=/academic/i',
  totPill:            '[class*="status"] >> text=/tree of thought/i',
  ragPill:            '[class*="status"] >> text=/rag/i',

  // Welcome / empty state
  welcomePanel:       '[data-testid="center-panel-welcome"]',

  // Error indicators
  errorModal:         '[role="alert"], [class*="error-modal"]',

  // Service interruption dialog ("AI Service Notification")
  serviceDialog:      'dialog[aria-modal="true"]',
  serviceDialogDismiss: 'dialog button:text-is("Dismiss"), dialog button:text-is("Got it"), dialog button[aria-label*="Close"]',
};

/* ─── Core chat actions ────────────────────────────────────────────── */

/**
 * Wait for SSE streaming to complete (cursor disappears).
 */
export async function waitForStreamComplete(page, timeout = 90000) {
  try {
    // First wait for cursor to appear (streaming started)
    await page.waitForSelector(SEL.streamingCursor, { state: 'visible', timeout: 15000 });
  } catch {
    // Cursor may have already gone or response was instant
  }
  try {
    await page.waitForSelector(SEL.streamingCursor, { state: 'hidden', timeout });
  } catch {
    // Already hidden
  }
  await page.waitForTimeout(500); // settle
}

/**
 * Dismiss any open service interruption / notification dialog that might block UI.
 * Safe to call even when no dialog is present.
 */
export async function dismissServiceDialog(page) {
  try {
    const dialog = page.locator(SEL.serviceDialog);
    if (await dialog.isVisible({ timeout: 1000 }).catch(() => false)) {
      // Try the labelled dismiss buttons first
      const dismissBtn = page.locator(SEL.serviceDialogDismiss).first();
      if (await dismissBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await dismissBtn.click();
      } else {
        await page.keyboard.press('Escape');
      }
      // Wait for dialog to close
      await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    }
  } catch {
    // No dialog present — fine
  }
}

/**
 * Send a chat message and wait for full bot response.
 * Returns the text content of the last bot message.
 */
export async function sendAndWait(page, text, timeout = 90000) {
  const input = page.locator('textarea').first();
  // Wait for textarea to be visible AND enabled (previous response must have finished)
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForSelector('textarea:not([disabled])', { timeout });
  // Dismiss any service dialog that might be blocking the UI
  await dismissServiceDialog(page);
  await input.fill(text);

  const sendBtn = page.locator(SEL.sendButton);
  if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await sendBtn.click();
  } else {
    await input.press('Enter');
  }

  // Wait for at least one bot message to appear
  await page.waitForSelector(SEL.botMessage, { timeout });

  // Wait for streaming to finish
  await waitForStreamComplete(page, timeout);

  return getLastBotText(page);
}

/**
 * Get the text content of the last bot message bubble.
 */
export async function getLastBotText(page) {
  const msgs = page.locator(SEL.botMessage);
  const count = await msgs.count();
  if (count === 0) return '';
  return (await msgs.nth(count - 1).textContent()) || '';
}

/**
 * Count how many bot message bubbles exist.
 */
export async function countBotMessages(page) {
  return page.locator(SEL.botMessage).count();
}

/* ─── Assertions ───────────────────────────────────────────────────── */

/**
 * Assert the last bot response has at least `minLength` characters.
 */
export async function assertBotResponse(page, minLength = 20) {
  const text = await getLastBotText(page);
  if (text.length < minLength) {
    throw new Error(`Bot response too short: ${text.length} chars (need ≥${minLength}). Text: "${text.slice(0, 100)}..."`);
  }
  return text;
}

/**
 * Assert the last bot response contains a code block.
 */
export async function assertHasCodeBlock(page) {
  const lastMsg = page.locator(SEL.botMessage).last();
  const codeBlock = lastMsg.locator('pre, code, [class*="code"]');
  const count = await codeBlock.count();
  if (count === 0) {
    throw new Error('Expected code block in bot response but found none');
  }
}

/**
 * Assert a thinking / ToT section is visible in the last response.
 */
export async function assertHasThinking(page) {
  const lastMsg = page.locator(SEL.botMessage).last();
  const thinking = lastMsg.locator('details, [class*="thinking"], [class*="thought"], summary');
  const count = await thinking.count();
  if (count === 0) {
    // Also check for "Thinking" or "Thought" text anywhere
    const text = await lastMsg.textContent();
    if (!text || (!/thinking/i.test(text) && !/thought/i.test(text) && !/reasoning/i.test(text))) {
      throw new Error('Expected thinking/ToT section in bot response but found none');
    }
  }
}

/**
 * Assert references / citations are present in the last response.
 */
export async function assertHasReferences(page) {
  const lastMsg = page.locator(SEL.botMessage).last();
  const text = await lastMsg.textContent();
  const hasRef = /source|reference|citation|\[[\d]+\]|https?:\/\//i.test(text || '');
  if (!hasRef) {
    // Check for links
    const links = await lastMsg.locator('a[href]').count();
    if (links === 0) {
      throw new Error('Expected references/citations in bot response but found none');
    }
  }
}

/**
 * Assert no error modal/alert is visible.
 */
export async function assertNoError(page) {
  const visible = await page.locator(SEL.errorModal).isVisible().catch(() => false);
  if (visible) {
    const errText = await page.locator(SEL.errorModal).textContent();
    throw new Error(`Unexpected error modal: ${errText}`);
  }
}

/* ─── Toggle helpers ───────────────────────────────────────────────── */

/**
 * Open the plus menu (More options) and click a toggle by text.
 */
async function openPlusMenuAndClick(page, textPattern) {
  const plusBtn = page.locator(SEL.plusButton);
  await plusBtn.waitFor({ state: 'visible', timeout: 5000 });
  await plusBtn.click();
  await page.waitForTimeout(400);

  const toggle = page.locator(`button`).filter({ hasText: textPattern }).first();
  await toggle.waitFor({ state: 'visible', timeout: 3000 });
  await toggle.click();
  await page.waitForTimeout(300);

  // Close menu
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

export async function toggleWebSearch(page) {
  await openPlusMenuAndClick(page, /web search/i);
}

export async function toggleAcademicSearch(page) {
  await openPlusMenuAndClick(page, /academic/i);
}

export async function toggleToT(page) {
  const totBtn = page.locator(SEL.totToggle);
  await totBtn.waitFor({ state: 'visible', timeout: 5000 });
  await totBtn.click();
  await page.waitForTimeout(300);
}

export async function toggleRAG(page) {
  const ragBtn = page.locator(SEL.ragToggle);
  await ragBtn.waitFor({ state: 'visible', timeout: 5000 });
  await ragBtn.click();
  await page.waitForTimeout(500);
}

/**
 * Select a course via the RAG / Knowledge Base dropdown.
 * Clicks the RAG toggle, then selects the course.
 */
export async function selectCourseViaRAG(page, courseName) {
  // Click RAG toggle to open the dropdown
  await toggleRAG(page);
  await page.waitForTimeout(500);

  // Look for the course in the dropdown / modal
  const courseOption = page.getByText(new RegExp(courseName, 'i')).first();
  await courseOption.waitFor({ state: 'visible', timeout: 5000 });
  await courseOption.click();
  await page.waitForTimeout(500);

  // Close any remaining popover
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/**
 * Deselect the current RAG course by clicking the × on the status chip,
 * or by toggling the RAG button if there's no × button.
 */
export async function deselectCourse(page) {
  // Try clicking × on the RAG status pill
  const ragChip = page.locator('button').filter({ hasText: /rag/i }).first();
  if (await ragChip.isVisible().catch(() => false)) {
    await ragChip.click();
    await page.waitForTimeout(500);
  }
  // Also try the × icon
  const closeBtn = page.locator('[aria-label*="deselect"], [aria-label*="remove"], [title*="deselect"]').first();
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click();
    await page.waitForTimeout(500);
  }
}

/**
 * Click the Prompt Coach button (Sparkles icon).
 */
export async function clickPromptCoach(page) {
  const btn = page.locator(SEL.promptCoach);
  await btn.waitFor({ state: 'visible', timeout: 5000 });
  await btn.click();
  await page.waitForTimeout(500);
}

/**
 * Click "New Chat" to clear the conversation.
 */
export async function clickNewChat(page) {
  // Ensure any in-progress response has finished and dialogs are dismissed
  await page.waitForSelector('textarea:not([disabled])', { timeout: 30000 }).catch(() => {});
  await dismissServiceDialog(page);
  const newChatBtn = page.getByRole('button', { name: /new chat/i })
    .or(page.getByTitle(/new chat/i));
  await newChatBtn.waitFor({ state: 'visible', timeout: 5000 });
  await newChatBtn.click();
  await page.waitForTimeout(2000);
}

/* ─── API helpers (bypass UI for setup/teardown) ───────────────────── */

/**
 * Get auth token by logging in via API.
 * Returns the JWT token string.
 */
export async function getAuthToken(page) {
  const response = await page.request.post(`${BASE_API}/auth/login`, {
    data: { email: 'ultra.boy7@gmail.com', password: '123456' }
  });
  const body = await response.json();
  return body.token;
}
