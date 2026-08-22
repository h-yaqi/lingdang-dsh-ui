'use strict';

/**
 * 预加载脚本：向 GUI 页面（main world）暴露 dshDesktop API。
 * 注入到设置页的"关于 dsh-desktop"卡片通过该 API 与主进程通信。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  /** @returns {Promise<{appVersion:string,dshVersion:string,nodeVersion:string,dshHome:string}>} */
  getVersions: () => ipcRenderer.invoke('dsh-desktop:get-versions'),
  /** @returns {Promise<{status:string,version?:string,message:string}>} */
  checkUpdate: () => ipcRenderer.invoke('dsh-desktop:check-update'),
});
