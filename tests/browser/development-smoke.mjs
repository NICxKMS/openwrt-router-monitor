import {chromium} from '@playwright/test';

const {NICX_DEV_DASHBOARD, NICX_DEV_FIXTURE_EMAIL, NICX_DEV_FIXTURE_PASSWORD} = process.env;
const url = new URL(NICX_DEV_DASHBOARD);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || !NICX_DEV_FIXTURE_EMAIL || !NICX_DEV_FIXTURE_PASSWORD) {
  throw new Error('Expected a disposable local dashboard and fixture credentials.');
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(url.origin);
  await page.getByLabel('Email address').fill(NICX_DEV_FIXTURE_EMAIL);
  await page.getByLabel('Password', {exact: true}).fill(NICX_DEV_FIXTURE_PASSWORD);
  await page.getByRole('button', {name: 'Sign in securely'}).click();
  await page.getByText('Simulated JIDU6111', {exact: true}).first().waitFor({state: 'visible'});
} finally {
  await browser.close();
}
