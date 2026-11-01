import { Download, Apple, Monitor } from "lucide-react";

export function DesktopDownloads() {
  // Existing Electron clients expose their runtime in the user agent; no shell update needed.
  if (/\bElectron\//.test(navigator.userAgent)) return null;
  return <details className="desktop-downloads">
    <summary><Download size={16} />客户端下载</summary>
    <div className="desktop-download-menu">
      <strong>把明账放在桌面上</strong>
      <a href="/downloads/mingzhang-mac-arm64.zip" download><Apple size={20} /><span>Mac 版<small>Apple Silicon · arm64 · ZIP</small></span><Download size={16} /></a>
      <a href="/downloads/mingzhang-windows11-x64.zip" download><Monitor size={20} /><span>Windows 11 版<small>Intel / AMD · 64 位 · ZIP</small></span><Download size={16} /></a>
      <p>Mac：解压后拖入「应用程序」。Windows：解压整个文件夹后运行「明账.exe」。</p>
      <p>客户端连接同一个账本服务，不包含本地账本。当前为未公证 / 未签名的个人试用版。</p>
    </div>
  </details>;
}
