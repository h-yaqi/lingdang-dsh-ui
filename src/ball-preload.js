'use strict';

/**
 * 悬浮球窗口预加载脚本：向 ball.html（main world）暴露 dshBall API。
 * 窗口移动、贴边吸附、面板展开/收起均由主进程控制，页面只发意图。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshBall', {
  /** @returns {Promise<string>} DSH 后端地址（每次调用取最新，后端重启换端口也能跟上）。 */
  getBackendUrl: () => ipcRenderer.invoke('ball:get-backend-url'),
  /** 拖动增量（dx, dy），主进程移动窗口。 */
  moveBall: (dx, dy) => ipcRenderer.send('ball:move', { dx, dy }),
  /** 按下球：贴边时先滑出，让拖动顺滑。 */
  pointerDown: () => ipcRenderer.send('ball:pointer-down'),
  /** 拖动结束，主进程检测是否贴边吸附。 */
  ballDropped: () => ipcRenderer.send('ball:dropped'),
  /** 展开/收起面板，主进程同步调整窗口尺寸（球保持原位）。 */
  setPanel: (open) => ipcRenderer.send('ball:panel', { open }),
  /** 点击"打开主窗口"：恢复并聚焦主窗口。 */
  activateMain: () => ipcRenderer.invoke('ball:activate-main'),
  /** 右键菜单：打开主窗口 / 退出悬浮球 / 退出应用。 */
  contextMenu: () => ipcRenderer.send('ball:context-menu'),
});
