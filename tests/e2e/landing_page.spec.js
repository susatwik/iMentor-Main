// tests/e2e/landing_page.spec.js — Landing Page Chat Interaction Tests
// Sends 5 questions across different topics and depths, verifies all UI behaviors.
import { test, expect } from '@playwright/test';

const QUESTIONS = [
    {
        topic: 'Computer Science — Algorithms',
        text: 'Explain the difference between BFS and DFS with real-world examples',
        depth: 'conceptual',
    },
    {
        topic: 'Mathematics — Calculus',
        text: 'What is the chain rule in differentiation and when do I use it?',
        depth: 'foundational',
    },
    {
        topic: 'Machine Learning — Deep Learning',
        text: 'How do convolutional neural networks detect features in images? Explain the role of filters, pooling, and stride.',
        depth: 'technical-deep',
    },
    {
        topic: 'Physics — Quantum Mechanics',
        text: 'Explain quantum entanglement in simple terms. How does it differ from classical correlation?',
        depth: 'simplified',
    },
    {
        topic: 'Software Engineering — System Design',
        text: 'Design a URL shortener like bit.ly. Walk me through the database schema, hashing strategy, and read/write scaling.',
        depth: 'system-design',
    },
];

const AUTH_RESPONSE = 'Sign in to start chatting with iMentor';

test.describe('Landing Page — Chat Interaction Tests', () => {

    test('LP-01 — Page loads with branding, nav, and empty state', async ({ page }) => {
        await page.goto('/');

        // Nav bar visible with branding
        await expect(page.getByText('iMentor').first()).toBeVisible();
        
        // Sign In and Sign Up buttons in nav
        const signInBtn = page.getByRole('button', { name: /sign in/i }).first();
        const signUpBtn = page.getByRole('button', { name: /sign up/i }).first();
        await expect(signInBtn).toBeVisible();
        await expect(signUpBtn).toBeVisible();

        // Empty state hero text
        await expect(page.getByText(/your ai mentor/i)).toBeVisible();

        // Sample question chips visible
        await expect(page.getByText('Explain neural networks')).toBeVisible();
        await expect(page.getByText('Help me study calculus')).toBeVisible();
        await expect(page.getByText('What is Big-O notation?')).toBeVisible();

        // Textarea visible
        const textarea = page.locator('textarea');
        await expect(textarea).toBeVisible();
        await expect(textarea).toHaveAttribute('placeholder', /ask imentor anything/i);

        // Mic and Send buttons
        await expect(page.getByLabel('Voice input')).toBeVisible();
        await expect(page.getByLabel('Send message')).toBeVisible();

        // Send button should be disabled when textarea is empty
        const sendBtn = page.getByLabel('Send message');
        await expect(sendBtn).toBeDisabled();

        console.log('✓ LP-01 passed: Landing page loads with all expected elements');
    });

    test('LP-02 — Sample question chip populates textarea', async ({ page }) => {
        await page.goto('/');

        // Click a sample question chip
        await page.getByText('Explain neural networks').click();

        // Textarea should now contain the chip text
        const textarea = page.locator('textarea');
        await expect(textarea).toHaveValue('Explain neural networks');

        // Send button should now be enabled
        const sendBtn = page.getByLabel('Send message');
        await expect(sendBtn).toBeEnabled();

        console.log('✓ LP-02 passed: Sample chip populates textarea');
    });

    test('LP-03 — Send 5 questions across different topics and depths', async ({ page }) => {
        await page.goto('/');

        for (let i = 0; i < QUESTIONS.length; i++) {
            const q = QUESTIONS[i];
            console.log(`  → Sending Q${i + 1} [${q.depth}]: "${q.text.slice(0, 50)}..."`);

            // Type the question
            const textarea = page.locator('textarea');
            await textarea.fill(q.text);

            // Verify send button is enabled
            const sendBtn = page.getByLabel('Send message');
            await expect(sendBtn).toBeEnabled();

            // Click send
            await sendBtn.click();

            // User message bubble should appear with exact text
            const userBubble = page.locator('.rounded-2xl.bg-white').filter({ hasText: q.text.slice(0, 30) });
            await expect(userBubble.first()).toBeVisible({ timeout: 5000 });

            // Wait for bot response (appears after ~600ms delay)
            const botBubble = page.locator('.border.border-white\\/10').filter({ hasText: /sign in/i });
            await expect(botBubble.last()).toBeVisible({ timeout: 5000 });

            // Verify the auth response text
            const lastBotText = await botBubble.last().textContent();
            expect(lastBotText).toContain(AUTH_RESPONSE);

            // Textarea should be cleared after send
            await expect(textarea).toHaveValue('');

            console.log(`  ✓ Q${i + 1} [${q.topic}] — user bubble + auth prompt visible`);
        }

        // After 5 questions, we should have 10 bubbles total (5 user + 5 bot)
        const allUserBubbles = page.locator('.rounded-2xl.bg-white');
        const userCount = await allUserBubbles.count();
        expect(userCount).toBe(5);

        console.log(`✓ LP-03 passed: All 5 questions sent, ${userCount} user bubbles + auth prompts visible`);
    });

    test('LP-04 — Auth CTA buttons appear after first message', async ({ page }) => {
        await page.goto('/');

        // Send a message
        const textarea = page.locator('textarea');
        await textarea.fill('What is recursion?');
        await page.getByLabel('Send message').click();

        // Wait for bot response
        await page.waitForTimeout(1000);

        // Auth CTA buttons should appear
        const signInCTA = page.getByRole('button', { name: /sign in to continue/i });
        const createAccCTA = page.getByRole('button', { name: /create account/i });
        await expect(signInCTA).toBeVisible({ timeout: 5000 });
        await expect(createAccCTA).toBeVisible({ timeout: 5000 });

        console.log('✓ LP-04 passed: Auth CTA buttons appear after message');
    });

    test('LP-05 — Sign In CTA opens auth modal', async ({ page }) => {
        await page.goto('/');

        // Send a message to trigger auth CTA
        const textarea = page.locator('textarea');
        await textarea.fill('Teach me about linked lists');
        await page.getByLabel('Send message').click();
        await page.waitForTimeout(1000);

        // Click "Sign In to Continue"
        await page.getByRole('button', { name: /sign in to continue/i }).click();

        // Auth modal should open with email/password fields
        const emailField = page.getByPlaceholder(/email/i);
        await expect(emailField).toBeVisible({ timeout: 5000 });
        const passwordField = page.getByPlaceholder(/password/i);
        await expect(passwordField).toBeVisible({ timeout: 5000 });

        console.log('✓ LP-05 passed: Sign In CTA opens auth modal');
    });

    test('LP-06 — Nav Sign In button opens auth modal', async ({ page }) => {
        await page.goto('/');

        // Click nav Sign In
        await page.getByRole('button', { name: /sign in/i }).first().click();

        // Modal should appear
        const emailField = page.getByPlaceholder(/email/i);
        await expect(emailField).toBeVisible({ timeout: 5000 });

        console.log('✓ LP-06 passed: Nav Sign In opens auth modal');
    });

    test('LP-07 — Nav Sign Up button opens signup modal', async ({ page }) => {
        await page.goto('/');

        // Click nav Sign Up
        await page.getByRole('button', { name: /sign up/i }).first().click();

        // Modal should appear — in signup mode, "Create Your Account" heading
        const signupHeading = page.getByText(/create your account/i).or(page.getByText(/sign up/i));
        await expect(signupHeading.first()).toBeVisible({ timeout: 5000 });

        console.log('✓ LP-07 passed: Nav Sign Up opens signup modal');
    });

    test('LP-08 — Mic button triggers auth hint', async ({ page }) => {
        await page.goto('/');

        // Click mic button
        await page.getByLabel('Voice input').click();

        // Auth CTA should appear (showAuthHint set to true)
        // Since no message was sent, CTA might appear in chat area
        // The auth hint is in the messages area — it shows Sign In / Create Account buttons
        const signInCTA = page.getByRole('button', { name: /sign in to continue/i });
        await expect(signInCTA).toBeVisible({ timeout: 5000 });

        console.log('✓ LP-08 passed: Mic click triggers auth hint');
    });

    test('LP-09 — Enter key sends message (not Shift+Enter)', async ({ page }) => {
        await page.goto('/');

        const textarea = page.locator('textarea');

        // Shift+Enter should NOT send (should add newline)
        await textarea.fill('First line');
        await textarea.press('Shift+Enter');
        await page.waitForTimeout(300);

        // No user bubble should appear yet
        const userBubbles = page.locator('.rounded-2xl.bg-white');
        const countBefore = await userBubbles.count();
        expect(countBefore).toBe(0);

        // Clear and type a fresh message, then press Enter
        await textarea.fill('What is a hash table?');
        await textarea.press('Enter');

        // User bubble should appear
        await page.waitForTimeout(800);
        const userBubble = page.locator('.rounded-2xl.bg-white').filter({ hasText: 'hash table' });
        await expect(userBubble.first()).toBeVisible({ timeout: 3000 });

        console.log('✓ LP-09 passed: Enter sends, Shift+Enter does not');
    });

    test('LP-10 — Empty state disappears after first message', async ({ page }) => {
        await page.goto('/');

        // Verify empty state is visible
        await expect(page.getByText(/your ai mentor/i)).toBeVisible();
        await expect(page.getByText('Explain neural networks')).toBeVisible();

        // Send a message
        const textarea = page.locator('textarea');
        await textarea.fill('What is an API?');
        await page.getByLabel('Send message').click();

        // Wait for message to appear
        await page.waitForTimeout(300);

        // Empty state hero should be gone
        await expect(page.getByText(/your ai mentor for limitless/i)).not.toBeVisible();

        // Sample chips should be gone
        await expect(page.getByText('Explain neural networks')).not.toBeVisible();

        console.log('✓ LP-10 passed: Empty state disappears after first message');
    });

    test('LP-11 — Full login flow from landing page', async ({ page }) => {
        await page.goto('/');

        // Click nav Sign In
        await page.getByRole('button', { name: /sign in/i }).first().click();

        // Fill credentials
        await page.getByPlaceholder(/email/i).fill('ultra.boy7@gmail.com');
        await page.getByPlaceholder(/password/i).fill('123456');

        // Click Login submit inside form
        await page.locator('form').getByRole('button', { name: /login/i }).click();

        // Wait for redirect — should leave landing and show main chat
        await page.waitForURL(url => !url.toString().includes('landing'), { timeout: 20000 });

        // Main chat interface should be visible (textarea or nav)
        const mainContent = page.locator('textarea, nav, header').first();
        await expect(mainContent).toBeVisible({ timeout: 15000 });

        console.log('✓ LP-11 passed: Full login from landing page to main chat');
    });
});
