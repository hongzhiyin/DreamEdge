import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';

/** A renderer crash never starts, retries or cancels the main-process model run. */
export function recoverRenderer(window: BrowserWindow, exiting: () => boolean): () => void {
  let attempts: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gone = (_event: unknown, details: { reason: string }) => {
    if (exiting() || window.isDestroyed() || details.reason === 'clean-exit') return;
    attempts = attempts.filter(time => Date.now() - time < 60_000);
    if (attempts.length >= 2) {
      if (process.env.DREAMEDGE_NO_DIALOGS !== '1') {
        void dialog.showMessageBox(window, { type: 'error', message: '聊天页面未能恢复。',
          detail: '请重新启动应用。后台没有因此重新发送对话。', buttons: ['确定'] });
      }
      return;
    }
    attempts.push(Date.now());
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!exiting() && !window.isDestroyed()) window.webContents.reload();
    }, 200);
  };
  window.webContents.on('render-process-gone', gone);
  return () => { clearTimeout(timer); window.webContents.removeListener('render-process-gone', gone); };
}
