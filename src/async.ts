import { Logger } from "./logger";

function wait(timeout = 250) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

interface RetryOptions {
  retries?: number;
  delay?: number;
}

/**
 * The IO effects sometimes fail due to different external issues - for example, network or filesystem.
 * To make these tests more reliable, we can wrap these effects in the `retry` function.
 */
async function retry<T>(
  effect: () => Promise<T>,
  logger: Logger,
  options: RetryOptions = {}
): Promise<T> {
  const retries = options.retries || 3;
  const delay = options.delay || 250;

  let lastError: unknown;

  for (let retry = 1; retry <= retries; ++retry) {
    try {
      return await effect();
    } catch (error) {
      logger.log(error.toString());
      logger.log(`Retry ${retry} of ${retries}.`);
      lastError = error;
      await wait(delay);
    }
  }

  throw lastError;
}

export { wait, retry, RetryOptions };
