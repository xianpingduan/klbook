import type { Locator, Page } from '@playwright/test';

/** Follow the visible disclosure controls before interacting with an optional field. */
export async function reveal(control: Locator) {
  await control.waitFor({ state: 'attached' });
  const closed = control.locator('xpath=ancestor::details[not(@open)]');
  while (await closed.count()) await closed.first().locator(':scope > summary').click();
}

export async function editAnswers(page: Page, name: string) {
  if (await page.getByRole('heading', { name: '错题详情', exact: true }).isVisible()) await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  const button = page.getByRole('button', { name, exact: true, includeHidden: true });
  await reveal(button); await button.click();
}
