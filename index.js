import 'dotenv/config';
import puppeteer from 'puppeteer';

if (!process.env.DOMAIN) {
  throw new Error('DOMAIN is not set');
}

if (!process.env.ACCOUNT_EMAIL) {
  throw new Error('ACCOUNT_EMAIL is not set');
}

if (!process.env.ACCOUNT_PASSWORD) {
  throw new Error('ACCOUNT_PASSWORD is not set');
}

const browser = await puppeteer.launch();
const page = await browser.newPage();

await page.goto(`https://${process.env.DOMAIN}/auth/sign_in`);

await page.waitForSelector('#user_email');
await page.type('#user_email', process.env.ACCOUNT_EMAIL);

await page.waitForSelector('#user_password');
await page.type('#user_password', process.env.ACCOUNT_PASSWORD);

await page.click('button[type=submit]');
await page.waitForNavigation();

console.log('Logged in');

async function deleteJobsUntilEmpty() {
  let count = 0;
  let rescue = 0;

  while (true) {
    const tableRows = await page.$$('table tbody tr');

    if (tableRows.length === 0) {
      break;
    }

    let found = false;

    for (const tableRow of tableRows) {
      // [checkbox], [latest retry], [queue], [job], [argument], [error]
      const jobElementHandle = await tableRow.$('td:nth-child(4)');
      const errorElementHandle = await tableRow.$('td:last-child');
      const jobText = (await page.evaluate(element => element.textContent, jobElementHandle)).trim();
      const errorText = (await page.evaluate(element => element.textContent, errorElementHandle)).trim();

      if (
        (errorText.startsWith('ActiveRecord::RecordInvalid:')) ||
        (errorText.startsWith('Encoding::InvalidByteSequenceError:')) ||
        (errorText.startsWith('HTTP::ConnectionError: failed to connect: No address')) ||
        (errorText.startsWith('NoMethodError:')) ||
        (errorText.startsWith('URI::InvalidURIError:')) ||
        (errorText.startsWith('Zlib::BufError:')) ||
        (jobText === 'LinkCrawlWorker' && errorText === 'ArgumentError: Attributes per element limit exceeded') ||
        (jobText === 'LinkCrawlWorker' && errorText === 'ArgumentError: Document tree depth limit exceeded') ||
        (jobText === 'LinkCrawlWorker' && errorText.startsWith('TypeError: no implicit conversion')) ||
        (jobText === 'Web::PushNotificationWorker' && errorText.startsWith('Mastodon::UnexpectedResponseError:'))
      ) {
        const checkboxElementHandle = await tableRow.$('td:first-child input');
        await checkboxElementHandle.click();
        count++;
        found = true;
      }
    }

    if (!found) {
      break;
    }

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    const deleteButtonElementHandle = await page.$('form[action="/sidekiq/morgue"] input[type=submit][name=delete]');
    try {
      await Promise.all([page.waitForNavigation(), deleteButtonElementHandle.click()]);
    }
    catch (error) {
      console.error(error);
      rescue++;

      if (rescue > 3) {
        break;
      }
    }
  }

  console.log(`Deleted ${count} jobs`);
}

async function retryJobsUntilEmpty() {
  let count = 0;
  let rescue = 0;

  while (true) {
    const tableRows = await page.$$('table tbody tr');

    if (tableRows.length === 0) {
      break;
    }

    let found = false;

    for (const tableRow of tableRows) {
      // [checkbox], [latest retry], [queue], [job], [argument], [error]
      const jobElementHandle = await tableRow.$('td:nth-child(4)');
      const errorElementHandle = await tableRow.$('td:last-child');
      const jobText = (await page.evaluate(element => element.textContent, jobElementHandle)).trim();
      const errorText = (await page.evaluate(element => element.textContent, errorElementHandle)).trim();

      if (
        (errorText.startsWith('Aws::S3::Errors:')) ||
        (errorText.startsWith('Mastodon::RaceConditionError:')) ||
        (jobText === 'LinkCrawlWorker' && errorText.startsWith('Seahorse::Client::NetworkingError:')) ||
        (jobText === 'RedownloadMediaWorker' && errorText.startsWith('Aws::S3::MultipartUploadError:')) ||
        (jobText === 'RedownloadMediaWorker' && errorText.startsWith('HTTP::TimeoutError:'))
      ) {
        const checkboxElementHandle = await tableRow.$('td:first-child input');
        await checkboxElementHandle.click();
        count++;
        found = true;
      }
    }

    if (!found) {
      break;
    }

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    const retryButtonElementHandle = await page.$('form[action="/sidekiq/morgue"] input[type=submit][name=retry]');
    try {
      await Promise.all([page.waitForNavigation(), retryButtonElementHandle.click()]);
    }
    catch (error) {
      console.error(error);
      rescue++;

      if (rescue > 3) {
        break;
      }
    }
  }

  console.log(`Retried ${count} jobs`);
}

while (true) {
  await page.goto(`https://${process.env.DOMAIN}/sidekiq/morgue`);

  const paginationElementHandle = await page.$('.pagination');

  let lastPageNumber = 1;

  if (paginationElementHandle) {
    const lastPageElementHandle = await paginationElementHandle.$('li:last-child a');

    if (lastPageElementHandle) {
      await Promise.all([page.waitForNavigation(), lastPageElementHandle.click()]);

      console.log('Navigated to the last page');

      lastPageNumber = parseInt(page.url().match(/page=(\d+)$/)[1]);
    }
  }

  console.log(`Last page number: ${lastPageNumber}`);

  for (let pageNumber = lastPageNumber; pageNumber > 0; pageNumber--) {
    await Promise.all([page.waitForNavigation(), page.goto(`https://${process.env.DOMAIN}/sidekiq/morgue?page=${pageNumber}`)]);

    console.log(`Processing page ${pageNumber}`);

    await deleteJobsUntilEmpty();
    await retryJobsUntilEmpty();
  }

  console.log('Waiting for 30 minutes before checking again');

  await new Promise(resolve => setTimeout(resolve, 1800_000));
}
