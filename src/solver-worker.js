import { solveSchedule } from './grouping.js?v=i18n-1';

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'solve') return;
  const { requestId, config, timeBudgetMs } = message;
  try {
    const result = solveSchedule(config, {
      timeBudgetMs: timeBudgetMs ?? 4000,
      onProgress: (progress) => self.postMessage({ type: 'progress', requestId, ...progress }),
    });
    self.postMessage({ type: 'result', requestId, result });
  } catch (error) {
    self.postMessage({
      type: 'error', requestId,
      message: error instanceof Error ? error.message : '求解失败，请检查分组设置。',
      messageEn: typeof error?.messageEn === 'string' ? error.messageEn : 'Unable to solve this configuration. Please check the grouping settings and try again.',
    });
  }
});
